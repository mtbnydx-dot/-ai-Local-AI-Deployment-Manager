// /engines/new (07 §6.5): the custom Docker engine builder. 01 makes custom
// engines descriptor files only, so this page builds, checks and prints the
// file; writing it stays manual.
//
//   基本信息 Basics → 启动映射 Launch mapping → 显存模型 Memory model → 确认 Review
//
// Review checks the descriptor in the browser first (lib/engines-model.js
// reviewDraft: the form rules and EngineDescriptorGuard). Only a descriptor that
// passes is sent to POST /api/m/<manager>/engines/descriptors/validate, which is
// side-effect free and answers { ok, errors[] }; on a 404 the manager has no such
// route and only the browser check is shown. The JSON can be copied or downloaded,
// next to the runtime-manifest entry its `runtimes.allowed` key needs.

import {
  BUILDER_ARTIFACT_FORMATS, BUILDER_MANAGERS, BUILDER_MEMORY_KINDS, BUILDER_STEPS, TEMPLATE_PLACEHOLDERS, buildRuntimeEntry, defaultDraft,
  descriptorFileName, fieldStep, reviewDraft, serverDescriptorErrors, summarizeEngines, validateDraft, validateUnavailable,
} from "../../lib/engines-model.js";
import { describeError } from "../../lib/api.js";
import { DescriptorValidationGuard, EnginesResponseGuard } from "../../lib/schemas.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { CodeBlock } from "../../components/code-block.js";
import { FormField } from "../../components/form-field.js";
import { PageHeader } from "../../components/page-header.js";
import { StatusBadge } from "../../components/status-badge.js";
import { Stepper } from "../../components/stepper.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useId, useMemo, useRef, useState } from "../../ui/vendor.js";
import { managerName } from "./engine-parts.js";

const IDLE = Object.freeze({ status: "idle", errors: [], error: null });

function saveJson(name, text) {
  try {
    const url = globalThis.URL.createObjectURL(new globalThis.Blob([text], { type: "application/json;charset=utf-8" }));
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

function useFieldErrors(errors) {
  const { t, has, tk } = useT();
  const byField = new Map();
  for (const error of errors) if (!byField.has(error.field)) byField.set(error.field, error);
  return (field) => {
    const error = byField.get(field);
    if (!error) return null;
    const key = tk("engines.page.new.err.", error.code);
    return has(key) ? t(key, error.params) : error.code;
  };
}

function BasicsStep({ draft, set, errorFor, managerLabel }) {
  const { t, tk } = useT();
  const toggleFormat = (format, on) => set("artifactFormats", on ? [...draft.artifactFormats, format] : draft.artifactFormats.filter((item) => item !== format));
  const text = (name, extra = {}) => (props) => html`<input ...${props} class=${`input${extra.mono ? " mono" : ""}`} autocomplete="off" autocapitalize="off" spellcheck="false" value=${draft[name]}
    onInput=${(event) => set(name, event.currentTarget.value)} data-testid=${`engine-new.field.${name}`} ...${extra.attrs || {}} />`;
  return html`<div class="stack-sm" data-testid="engine-new.basics">
    <${FormField} label=${t("engines.page.new.id")} required hint=${t("engines.page.new.idHint")} error=${errorFor("id")}>${text("id", { mono: true, attrs: { "data-autofocus": "" } })}<//>
    <div class="row">
      <${FormField} label=${t("engines.page.new.labelZh")} required error=${errorFor("labelZh")}>${text("labelZh")}<//>
      <${FormField} label=${t("engines.page.new.labelEn")} required error=${errorFor("labelEn")}>${text("labelEn")}<//>
    </div>
    <${FormField} label=${t("engines.page.new.manager")} hint=${t("engines.page.new.managerHint")} error=${errorFor("hostManager")}>
      ${(props) => html`<select ...${props} class="select" value=${draft.hostManager} onChange=${(event) => set("hostManager", event.currentTarget.value)} data-testid="engine-new.field.hostManager">
        ${BUILDER_MANAGERS.map((id) => html`<option key=${id} value=${id}>${managerLabel(id)}</option>`)}</select>`}
    <//>
    <${FormField} label=${t("engines.page.new.image")} required hint=${t("engines.page.new.imageHint")} error=${errorFor("image")}>${text("image", { mono: true })}<//>
    <div class="row">
      <${FormField} label=${t("engines.page.new.port")} required hint=${t("engines.page.new.portHint")} error=${errorFor("port")}>${text("port", { mono: true, attrs: { inputmode: "numeric" } })}<//>
      <${FormField} label=${t("engines.page.new.health")} hint=${t("engines.page.new.healthHint")} error=${errorFor("healthPath")}>${text("healthPath", { mono: true })}<//>
    </div>
    <fieldset class="field" data-testid="engine-new.formats">
      <legend class="field-label">${t("engines.page.new.formats")}</legend>
      <div class="row">${BUILDER_ARTIFACT_FORMATS.map((format) => html`<label key=${format} class="check">
        <input type="checkbox" checked=${draft.artifactFormats.includes(format)} onChange=${(event) => toggleFormat(format, event.currentTarget.checked)} data-testid=${`engine-new.format.${format}`} /> ${format}</label>`)}</div>
      ${errorFor("artifactFormats") ? html`<div class="field-error">${errorFor("artifactFormats")}</div>` : null}
    </fieldset>
  </div>`;
}

function MappingStep({ draft, set, errorFor }) {
  const { t } = useT();
  const listId = useId();
  const setRow = (index, name, value) => set("args", draft.args.map((row, at) => (at === index ? { ...row, [name]: value } : row)));
  return html`<div class="stack-sm" data-testid="engine-new.mapping">
    <p class="muted">${t("engines.page.new.mappingIntro")}</p>
    <${FormField} label=${t("engines.page.new.entrypoint")} hint=${t("engines.page.new.entrypointHint")} error=${errorFor("entrypoint")}>
      ${(props) => html`<input ...${props} class="input mono" autocomplete="off" spellcheck="false" value=${draft.entrypoint} onInput=${(event) => set("entrypoint", event.currentTarget.value)} data-testid="engine-new.field.entrypoint" />`}
    <//>
    <fieldset class="stack-sm">
      <legend class="field-label">${t("engines.page.new.args")}</legend>
      ${errorFor("args") ? html`<div class="field-error">${errorFor("args")}</div>` : null}
      ${draft.args.map((row, index) => html`<div key=${index} class="row" data-testid="engine-new.arg">
        <${FormField} label=${t("engines.page.new.argFlag", { n: index + 1 })} error=${errorFor(`args.${index}.flag`)}>
          ${(props) => html`<input ...${props} class="input mono" autocomplete="off" spellcheck="false" placeholder="--flag" value=${row.flag} onInput=${(event) => setRow(index, "flag", event.currentTarget.value)} data-testid="engine-new.arg.flag" />`}
        <//>
        <${FormField} label=${t("engines.page.new.argValue", { n: index + 1 })} required error=${errorFor(`args.${index}.value`)}>
          ${(props) => html`<input ...${props} class="input mono" list=${listId} autocomplete="off" spellcheck="false" value=${row.value} onInput=${(event) => setRow(index, "value", event.currentTarget.value)} data-testid="engine-new.arg.value" />`}
        <//>
        <${Button} size="sm" variant="ghost" onClick=${() => set("args", draft.args.filter((_, at) => at !== index))} label=${t("engines.page.new.argRemove", { n: index + 1 })} testid="engine-new.arg.remove">${t("engines.page.new.remove")}<//>
      </div>`)}
      <datalist id=${listId}>${TEMPLATE_PLACEHOLDERS.map((name) => html`<option key=${name} value=${`{{${name}}}`}></option>`)}</datalist>
      <div><${Button} size="sm" onClick=${() => set("args", [...draft.args, { flag: "", value: "" }])} testid="engine-new.arg.add">${t("engines.page.new.argAdd")}<//></div>
    </fieldset>
    <details>
      <summary>${t("engines.page.new.placeholders")}</summary>
      <ul class="small">${TEMPLATE_PLACEHOLDERS.map((name) => html`<li key=${name}><code class="code-inline">${`{{${name}}}`}</code></li>`)}</ul>
      <p class="small muted">${t("engines.page.new.placeholdersNote")}</p>
    </details>
  </div>`;
}

function MemoryStep({ draft, set, errorFor }) {
  const { t, tk } = useT();
  return html`<fieldset class="stack-sm" data-testid="engine-new.memory">
    <legend class="field-label">${t("engines.page.new.memory")}</legend>
    <p class="muted">${t("engines.page.new.memoryIntro")}</p>
    ${BUILDER_MEMORY_KINDS.map((kind) => html`<label key=${kind} class="check">
      <input type="radio" name="memory-kind" value=${kind} checked=${draft.memoryKind === kind} onChange=${() => set("memoryKind", kind)} data-testid=${`engine-new.memory.${kind}`} />
      <span><strong>${t(tk("engines.page.new.memory.name.", kind))}</strong><span class="small muted"> ${t(tk("engines.page.new.memory.help.", kind))}</span></span></label>`)}
    ${errorFor("memoryKind") ? html`<div class="field-error">${errorFor("memoryKind")}</div>` : null}
  </fieldset>`;
}

function ServerCheck({ result, onRetry }) {
  const { t } = useT();
  const unknownRuntime = result.errors.some((item) => item.code === "unknown_runtime" || item.code === "default_runtime_unresolved");
  if (result.status === "checking") return html`<${StatusBadge} status="loading" label=${t("engines.page.new.server.checking")} testid="engine-new.server" />`;
  if (result.status === "browser-only") {
    return html`<div class="stack-sm" data-testid="engine-new.server" data-state="browser-only">
      <${StatusBadge} status="info" label=${t("engines.page.new.server.browserOnly")} />
      <p class="small muted">${t("engines.page.new.server.browserOnlyBody")}</p></div>`;
  }
  if (result.status === "failed") {
    return html`<div class="stack-sm" data-testid="engine-new.server" data-state="failed">
      <${StatusBadge} status="warn" label=${t("engines.page.new.server.failed")} />
      <p class="small" data-testid="engine-new.server-failure">${result.message}</p>
      <div><${Button} size="sm" onClick=${onRetry} testid="engine-new.recheck">${t("engines.page.new.server.recheck")}<//></div></div>`;
  }
  if (result.status === "done" && result.ok) {
    return html`<div class="stack-sm" data-testid="engine-new.server" data-state="ok"><${StatusBadge} status="ok" label=${t("engines.page.new.server.passed")} /></div>`;
  }
  if (result.status === "done") {
    return html`<div class="stack-sm" data-testid="engine-new.server" data-state="errors">
      <${StatusBadge} status="error" label=${t("engines.page.new.server.errors", { count: result.errors.length })} />
      <ul data-testid="engine-new.server-errors" class="stack-sm">${result.errors.map((item, index) => html`<li key=${index} data-code=${item.code}>
        <code class="code-inline">${item.path || "—"}</code> <span class="muted">${item.code}</span> <span data-user-content="">${item.message}</span></li>`)}</ul>
      ${unknownRuntime ? html`<div class="notice notice-warn" data-testid="engine-new.manifest-hint">${t("engines.page.new.server.manifestHint")}</div>` : null}
      <div><${Button} size="sm" onClick=${onRetry} testid="engine-new.recheck">${t("engines.page.new.server.recheck")}<//></div></div>`;
  }
  return null;
}

function ReviewStep({ draft, review, server, onRetry, onFix, managerLabel }) {
  const { t, has, tk } = useT();
  const descriptorText = review.descriptor ? JSON.stringify(review.descriptor, null, 2) : "";
  const runtimeText = review.descriptor ? JSON.stringify(buildRuntimeEntry(draft), null, 2) : "";
  const file = descriptorFileName(draft);
  const [downloaded, setDownloaded] = useState(null);
  return html`<div class="stack" data-testid="engine-new.review">
    <div class="stack-sm">
      <h3 class="card-title">${t("engines.page.new.check")}</h3>
      ${review.ok
        ? html`<div class="row"><${StatusBadge} status="ok" label=${t("engines.page.new.browser.passed")} testid="engine-new.browser" /></div>`
        : html`<div class="stack-sm" data-testid="engine-new.browser-errors">
          <${StatusBadge} status="error" label=${t("engines.page.new.browser.errors", { count: review.errors.length })} testid="engine-new.browser" />
          <ul class="stack-sm">${review.errors.map((item, index) => html`<li key=${index}>
            <code class="code-inline">${item.field}</code> ${has(tk("engines.page.new.err.", item.code)) ? t(tk("engines.page.new.err.", item.code), item.params) : item.code}
            <${Button} size="sm" variant="ghost" onClick=${() => onFix(fieldStep(item.field))} testid="engine-new.fix">${t("engines.page.new.fix")}<//></li>`)}</ul></div>`}
      ${review.ok ? html`<${ServerCheck} result=${server} onRetry=${onRetry} />` : null}
    </div>
    ${review.ok ? html`
      <${Card} title=${t("engines.page.new.fileTitle", { file })} level=${3} testid="engine-new.file">
        <p class="small muted">${t("engines.page.new.fileFolder")} <code class="code-inline" data-testid="engine-new.folder">${`<AI_ROOT>/config/engines/${file}`}</code></p>
        <${CodeBlock} code=${descriptorText} language="json" copyLabel=${t("engines.page.new.copy")} testid="engine-new.json" />
        <div class="row">
          <${Button} onClick=${() => setDownloaded(saveJson(file, `${descriptorText}\n`))} testid="engine-new.download">${t("engines.page.new.download")}<//>
          ${downloaded === false ? html`<span class="small text-danger" role="status">${t("engines.page.new.downloadFailed")}</span>` : null}
        </div>
      <//>
      <${Card} title=${t("engines.page.new.runtimeTitle")} level=${3} testid="engine-new.runtime">
        <p class="small muted">${t("engines.page.new.runtimeBody")} <code class="code-inline">${"<AI_ROOT>/config/runtime-manifest.json"}</code></p>
        <${CodeBlock} code=${runtimeText} language="json" copyLabel=${t("engines.page.new.copyRuntime")} testid="engine-new.runtime-json" />
      <//>
      <${Card} title=${t("engines.page.new.afterTitle")} level=${3} testid="engine-new.after">
        <ol class="stack-sm">
          <li>${t("engines.page.new.after1")}</li>
          <li>${t("engines.page.new.after2", { manager: managerLabel(draft.hostManager) })}</li>
          <li>${t("engines.page.new.after3")}</li>
        </ol>
      <//>` : null}
  </div>`;
}

export default function EngineNewPage() {
  const { api, i18n } = useServices();
  const { t, has, tk } = useT();
  const aggregate = useQuery(["engines"], () => api.get("/api/engines", { guard: EnginesResponseGuard }), { ttlMs: 10000 });
  const knownIds = useMemo(() => (aggregate.data ? summarizeEngines(aggregate.data).engines.map((engine) => engine.engineId) : []), [aggregate.data]);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [draft, setDraft] = useState(defaultDraft);
  const [step, setStep] = useState(BUILDER_STEPS[0]);
  const [attempted, setAttempted] = useState([]);
  const [server, setServer] = useState(IDLE);
  const latest = useRef("");
  const set = (name, value) => setDraft((current) => ({ ...current, [name]: value }));
  const managerLabel = (id) => managerName(t, has, tk, id);

  const form = validateDraft(draft, { knownIds });
  const review = useMemo(() => reviewDraft(draft, { knownIds, today }), [draft, knownIds, today]);
  const shownErrors = form.errors.filter((error) => attempted.includes(fieldStep(error.field)));
  const errorFor = useFieldErrors(shownErrors);
  const index = BUILDER_STEPS.indexOf(step);

  const json = review.ok ? JSON.stringify(review.descriptor) : "";
  async function check() {
    if (!review.ok) return;
    const key = json;
    latest.current = key;
    setServer({ status: "checking", errors: [], error: null });
    try {
      const result = await api.manager(draft.hostManager).post("/engines/descriptors/validate", { descriptor: review.descriptor }, { guard: DescriptorValidationGuard });
      if (latest.current === key) setServer({ status: "done", ok: result.ok === true, errors: serverDescriptorErrors(result), error: null });
    } catch (error) {
      if (latest.current !== key) return;
      setServer(validateUnavailable(error)
        ? { status: "browser-only", errors: [], error: null }
        : { status: "failed", errors: [], error, message: describeError(error, i18n) });
    }
  }
  useEffect(() => {
    if (step === "review" && review.ok) check();
    else latest.current = "";
  }, [step, json, draft.hostManager]);

  function next() {
    const seen = BUILDER_STEPS.slice(0, index + 1);
    setAttempted((current) => [...new Set([...current, ...seen])]);
    const blocked = form.errors.find((error) => seen.includes(fieldStep(error.field)));
    if (blocked) {
      setStep(fieldStep(blocked.field));
      return;
    }
    setStep(BUILDER_STEPS[Math.min(index + 1, BUILDER_STEPS.length - 1)]);
  }

  const steps = BUILDER_STEPS.map((id, at) => ({
    id,
    label: t(tk("engines.page.new.step.", id)),
    state: id === step ? "active" : at < index ? "done" : "pending",
  }));
  const common = { draft, set, errorFor };
  return html`<div class="stack" data-testid="engine-new">
    <${PageHeader} title=${t("engines.page.new.title")} subtitle=${t("engines.page.new.subtitle")}
      breadcrumbs=${[{ label: t("shell.nav.engines"), href: "/engines" }, { label: t("engines.page.new.title") }]} />
    <${Stepper} steps=${steps} label=${t("engines.page.new.steps")} testid="engine-new.steps" />
    <${Card} title=${t(tk("engines.page.new.step.", step))} testid="engine-new.card">
      ${step === "basics" ? html`<${BasicsStep} ...${common} managerLabel=${managerLabel} />` : null}
      ${step === "mapping" ? html`<${MappingStep} ...${common} />` : null}
      ${step === "memory" ? html`<${MemoryStep} ...${common} />` : null}
      ${step === "review" ? html`<${ReviewStep} draft=${draft} review=${review} server=${server} onRetry=${check} managerLabel=${managerLabel}
        onFix=${(target) => {
          setAttempted((current) => [...new Set([...current, target])]);
          setStep(target);
        }} />` : null}
      <div class="row" data-testid="engine-new.nav">
        <${Button} onClick=${() => setStep(BUILDER_STEPS[Math.max(0, index - 1)])} disabled=${index === 0} testid="engine-new.back">${t("engines.page.new.back")}<//>
        ${step === "review" ? null : html`<${Button} variant="primary" onClick=${next} testid="engine-new.next">${t(index === BUILDER_STEPS.length - 2 ? "engines.page.new.toReview" : "engines.page.new.next")}<//>`}
      </div>
    <//>
  </div>`;
}
