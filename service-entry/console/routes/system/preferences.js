// /system/preferences (07 §6.13, CON-24): theme, language, density, browser
// notifications and Reset. Open to a viewer; nothing here calls the API.
//
// Each control writes through services.prefs (lib/prefs.js): localStorage plus
// the console_prefs cookie the server reads. Theme and density apply at once
// (app.js listens to the store and sets html[data-theme] / [data-density]).
// A language change reloads the page once, because the catalog is loaded for
// one locale per page load (app.js).

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { FormField } from "../../components/form-field.js";
import { PageHeader } from "../../components/page-header.js";
import { DEFAULT_PREFS } from "../../lib/prefs.js";
import { useServices } from "../../ui/context.js";
import { usePref, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { SystemNav } from "./subnav.js";

// What Reset returns to its default. The language goes last, because changing it reloads the page.
const RESET_ORDER = Object.freeze(["theme", "density", "notifyBrowser", "sidebar", "tableColumns", "locale"]);

/** Desktop notifications need a secure context and the Notification API. */
export function notificationSupport(win = globalThis) {
  const supported = Boolean(win.isSecureContext && typeof win.Notification === "function");
  return { supported, denied: supported && win.Notification.permission === "denied" };
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function Choice({ id, label, hint, value, options, onChange, testid }) {
  return html`<${FormField} id=${id} label=${label} hint=${hint} testid=${`${testid}.field`}>
    ${(control) => html`<select ...${control} class="select" value=${value} onChange=${(event) => onChange(event.currentTarget.value)} data-testid=${testid}>
      ${options.map(([optionValue, text]) => html`<option key=${optionValue} value=${optionValue} selected=${optionValue === value}>${text}</option>`)}
    </select>`}
  <//>`;
}

export default function Preferences() {
  const { prefs, toasts } = useServices();
  const { t } = useT();
  const role = useRole();
  const [theme, setTheme] = usePref("theme");
  const [locale, setLocale] = usePref("locale");
  const [density, setDensity] = usePref("density");
  const [notify, setNotify] = usePref("notifyBrowser");
  const [asking, setAsking] = useState(false);
  const support = notificationSupport();

  async function toggleNotify(on) {
    let granted = false;
    if (on) {
      try {
        granted = (await globalThis.Notification.requestPermission()) === "granted";
      } catch {
        granted = false;
      }
    }
    setNotify(on && granted);
  }

  function reset() {
    for (const name of RESET_ORDER) {
      if (!sameValue(prefs.get(name), DEFAULT_PREFS[name])) prefs.set(name, DEFAULT_PREFS[name]);
    }
    toasts?.push?.({ level: "success", title: t("prefs.title"), body: t("prefs.reset.done") });
  }

  const hint = !support.supported ? t("prefs.notify.unsupported") : support.denied ? t("prefs.notify.denied") : t("prefs.notify.hint");
  return html`<div class="stack" data-testid="prefs.root">
    <${PageHeader} title=${t("prefs.title")} subtitle=${t("prefs.subtitle")} />
    <${SystemNav} current="preferences" owner=${role === "owner"} />
    <${Card} title=${t("prefs.appearance")} level=${2} testid="prefs.appearance">
      <div class="stack">
        <${Choice} id="prefs-theme" label=${t("prefs.theme.label")} value=${theme} onChange=${setTheme} testid="prefs.theme"
          options=${[["auto", t("prefs.theme.auto")], ["light", t("prefs.theme.light")], ["dark", t("prefs.theme.dark")]]} />
        <${Choice} id="prefs-locale" label=${t("prefs.locale.label")} hint=${t("prefs.locale.hint")} value=${locale} onChange=${setLocale} testid="prefs.locale"
          options=${[["auto", t("prefs.locale.auto")], ["zh-CN", t("shell.lang.zh")], ["en-US", t("shell.lang.en")]]} />
        <${Choice} id="prefs-density" label=${t("prefs.density.label")} value=${density} onChange=${setDensity} testid="prefs.density"
          options=${[["comfortable", t("prefs.density.comfortable")], ["compact", t("prefs.density.compact")]]} />
      </div>
    <//>
    <${Card} title=${t("prefs.notify.label")} level=${2} testid="prefs.notifications">
      <div class="stack-sm">
        <label class="check">
          <input type="checkbox" checked=${Boolean(notify) && !support.denied} disabled=${!support.supported || (support.denied && !notify)}
            onChange=${(event) => toggleNotify(event.currentTarget.checked)} data-testid="prefs.notify" />
          ${t("prefs.notify.toggle")}
        </label>
        <p class="muted small" data-testid="prefs.notify.hint">${hint}</p>
      </div>
    <//>
    <div class="row">
      <${Button} onClick=${() => setAsking(true)} testid="prefs.reset">${t("prefs.reset.button")}<//>
    </div>
    <${ConfirmDialog} open=${asking} title=${t("prefs.reset.title")} body=${t("prefs.reset.body")} confirmLabel=${t("prefs.reset.button")}
      onConfirm=${reset} onClose=${() => setAsking(false)} testid="prefs.reset-confirm" />
  </div>`;
}
