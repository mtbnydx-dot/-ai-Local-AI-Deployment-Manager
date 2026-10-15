// /access/public (07 §6.10, 05 §13.5): the seven-step wizard that opens the
// platform to outside users: topology → public address → generated files →
// keys → live checks → exposure map → go live. The steps guide and never gate:
// Back and Next are always available, and the platform starts nothing, the
// owner runs the printed commands. Topology and address are saved through
// PATCH /api/public/settings; the steps live in public-steps.js (files, keys,
// checks, map) and public-golive.js (enforcing the gateway-only modes).

import { baseUrlPatch, CLOUDFLARE_MODES, parseBaseUrl, publicKeys, readSettings, stepOutcomes, stepperStates, TOPOLOGIES, WIZARD_STEPS } from "../../lib/exposure-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { PageHeader } from "../../components/page-header.js";
import { Stepper } from "../../components/stepper.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useId, useRef, useState } from "../../ui/vendor.js";
import { accessError } from "./errors.js";
import { GoLiveStep } from "./public-golive.js";
import { ChecksStep, KeysStep, MapStep, TemplatesStep } from "./public-steps.js";

function TopologyStep({ topology, mode, onTopology, onMode }) {
  const { t } = useT();
  const name = useId();
  return html`<div class="stack" data-testid="public.topology">
    <p>${t("public.intro.topology")}</p>
    <div class="pw-cards" role="radiogroup" aria-label=${t("public.steps.topology")}>
      ${TOPOLOGIES.map((item) => html`<label key=${item.id} class="pw-card" data-selected=${topology === item.id ? "true" : "false"} data-testid=${`public.topology.${item.id}`}>
        <input type="radio" name=${name} value=${item.id} checked=${topology === item.id} onChange=${() => onTopology(item.id)} />
        <span class="pw-card-title">${t(tk("public.topology.", item.id, "title"))}${item.recommended ? html` <span class="badge badge-info">${t("public.topology.recommended")}</span>` : null}</span>
        <span class="small">${t(tk("public.topology.", item.id, "pro"))}</span>
        <span class="small muted">${t(tk("public.topology.", item.id, "con"))}</span>
      </label>`)}
    </div>
    ${topology === "cloudflared" ? html`<fieldset class="kf-overlap" data-testid="public.topology.modes">
      <legend class="field-label">${t("public.topology.mode")}</legend>
      ${CLOUDFLARE_MODES.map((item) => html`<label key=${item} class="check"><input type="radio" name=${`${name}-mode`} checked=${mode === item} onChange=${() => onMode(item)} data-testid=${`public.topology.mode.${item}`} />${t(tk("public.topology.mode.", item))}</label>`)}
    </fieldset>` : null}
  </div>`;
}

function BaseUrlStep({ topology, settings, onSaved }) {
  const { t, has } = useT();
  const services = useServices();
  const { api, cache, i18n } = services;
  const id = useId();
  const [text, setText] = useState(settings.baseUrl);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setText(settings.baseUrl);
  }, [settings.baseUrl]);
  if (topology === "lan") return html`<p class="notice" data-testid="public.baseurl.lan">${t("public.baseUrl.lan")}</p>`;

  const parsed = parseBaseUrl(text);
  const problem = text.trim() && !parsed.ok ? parsed.code : null;

  async function save() {
    if (!parsed.ok || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const body = baseUrlPatch(parsed.value);
      const answer = await api.patch("/api/public/settings", body, { headers: { "if-match": settings.etag } });
      setResult({ restartRequired: Array.isArray(answer?.restartRequired) ? answer.restartRequired : [] });
      cache.invalidate(["access", "settings"]);
      cache.invalidate(["access", "templates"]);
      onSaved?.(parsed.value);
    } catch (error) {
      if (error?.code === "config_conflict" || error?.status === 409) cache.invalidate(["access", "settings"]);
      setFailure({ message: accessError(error, i18n) });
    } finally {
      setBusy(false);
    }
  }

  return html`<form class="stack" onSubmit=${(event) => {
    event.preventDefault();
    save();
  }} data-testid="public.baseurl">
    <p>${t("public.intro.baseUrl")}</p>
    <div class="field">
      <label class="field-label" for=${id}>${t("public.baseUrl.label")}</label>
      <input id=${id} class="input mono" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://ai.example.com" value=${text}
        aria-invalid=${problem ? "true" : undefined} aria-describedby=${`${id}-hint`}
        onInput=${(event) => {
          touched.current = true;
          setText(event.currentTarget.value);
          setResult(null);
          setFailure(null);
        }} data-testid="public.baseurl.input" />
      <div id=${`${id}-hint`} class="field-hint">${t("public.baseUrl.help")}</div>
      ${problem && has(tk("public.baseUrl.err.", problem)) ? html`<div class="field-error" role="alert" data-testid="public.baseurl.error">${t(tk("public.baseUrl.err.", problem))}</div>` : null}
    </div>
    ${settings.baseUrl ? html`<p class="small muted" data-testid="public.baseurl.current">${t("public.baseUrl.current", { url: settings.baseUrl })}</p>` : null}
    <div class="row">
      <${Button} variant="primary" type="submit" busy=${busy} disabled=${!parsed.ok || parsed.value === settings.baseUrl} testid="public.baseurl.save">${t("public.baseUrl.save")}<//>
    </div>
    ${failure?.message ? html`<p class="notice notice-danger" role="alert" data-testid="public.baseurl.failure">${failure.message}</p>` : null}
    ${result ? html`<p class="notice notice-success" role="status" data-testid="public.baseurl.saved">${t("public.baseUrl.saved")}${result.restartRequired.length ? ` ${t("public.restart", { list: result.restartRequired.join(", ") })}` : ""}</p>` : null}
  </form>`;
}

export default function PublicAccess({ query = {} }) {
  const { api } = useServices();
  const { t } = useT();
  const [step, setStep] = useState(() => (WIZARD_STEPS.includes(query.step) ? query.step : "topology"));
  const [topology, setTopology] = useState("cloudflared");
  const [mode, setMode] = useState("token");
  const [written, setWritten] = useState(false);
  const [mapSeen, setMapSeen] = useState(false);
  const heading = useRef(null);
  const first = useRef(true);
  const index = WIZARD_STEPS.indexOf(step);

  const settingsQuery = useQuery(["access", "settings"], () => api.get("/api/public/settings"), { ttlMs: 10_000 });
  const keysQuery = useQuery(["access", "keys", "public"], () => api.get("/api/access/keys", { query: { status: "active", limit: 200 } }), { ttlMs: 10_000 });
  // The scan reads the machine's listeners, so it runs only once the wizard reaches the checks.
  const exposure = useQuery(["access", "exposure"], () => api.get("/api/public/exposure"), { ttlMs: 30_000, enabled: index >= WIZARD_STEPS.indexOf("checks") });
  const settings = readSettings(settingsQuery.data);
  const report = exposure.data?.report || null;
  const keyCount = publicKeys(keysQuery.data?.items).length;

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (step === "map") setMapSeen(true);
  }, [step]);

  const outcomes = stepOutcomes({ topology, settings: settingsQuery.data ? settings : null, written, publicKeyCount: keyCount, report, mapSeen });
  const states = stepperStates(step, outcomes);
  const steps = states.map((item) => ({ id: item.id, label: t(tk("public.steps.", item.id)), state: item.state }));
  const tt = TOPOLOGIES.find((item) => item.id === topology);

  const panel = () => {
    if (step === "topology") return html`<${TopologyStep} topology=${topology} mode=${mode} onTopology=${setTopology} onMode=${setMode} />`;
    if (step === "baseUrl") return html`<${BaseUrlStep} topology=${topology} settings=${settings} />`;
    if (step === "templates") return html`<${TemplatesStep} topology=${topology} mode=${mode} baseUrl=${settings.baseUrl} needsBaseUrl=${tt.needsBaseUrl} onWritten=${() => setWritten(true)} />`;
    if (step === "keys") return html`<${KeysStep} keys=${keysQuery.data?.items} loading=${keysQuery.status === "loading" && !keysQuery.data} failed=${keysQuery.status === "error" && !keysQuery.data} />`;
    if (step === "checks") return html`<${ChecksStep} query=${exposure} settings=${settings} />`;
    if (step === "map") return html`<${MapStep} query=${exposure} />`;
    return html`<${GoLiveStep} settings=${settings} report=${report} />`;
  };

  return html`<div class="stack" data-testid="public.root">
    <${PageHeader} title=${t("public.title")} subtitle=${t("public.subtitle")}
      breadcrumbs=${[{ label: t("shell.nav.access"), href: "/access" }, { label: t("public.title") }]} />
    <div class="pw-layout">
      <nav aria-label=${t("public.stepsLabel")} data-testid="public.steps"><${Stepper} steps=${steps} orientation="vertical" label=${t("public.stepsLabel")} /></nav>
      <section class="card stack" aria-labelledby="public-step-title" data-testid=${`public.step.${step}`}>
        <h2 id="public-step-title" class="card-title" tabindex="-1" ref=${heading}>${index + 1}. ${t(tk("public.steps.", step))}</h2>
        ${settingsQuery.status === "error" && !settingsQuery.data ? html`<p class="notice notice-danger" role="alert" data-testid="public.settings-failed">${t("public.settingsFailed")}
          <${Button} size="sm" onClick=${settingsQuery.refetch}>${t("access.retry")}<//></p>` : panel()}
        <div class="row pw-nav">
          <${Button} onClick=${() => setStep(WIZARD_STEPS[index - 1])} disabled=${index === 0} testid="public.back">${t("public.back")}<//>
          <span class="spacer"></span>
          ${index < WIZARD_STEPS.length - 1 ? html`<${Button} variant="primary" onClick=${() => setStep(WIZARD_STEPS[index + 1])} testid="public.next">${t("public.next")}<//>` : null}
        </div>
      </section>
    </div>
  </div>`;
}
