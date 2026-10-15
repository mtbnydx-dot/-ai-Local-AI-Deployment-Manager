// 中文 / English. Each button carries its own lang attribute, so the language
// names stay readable (and out of the "no Han text" check) in either mode.

import { html } from "../lib/html.js";
import { usePortal } from "../lib/context.js";

const OPTIONS = [
  { lang: "zh-CN", label: "中文" },
  { lang: "en-US", label: "English" },
];

export function LangSwitch() {
  const { t, lang, setLang } = usePortal();
  return html`<div class="lang-switch" role="group" aria-label=${t("lang.label")}>
    ${OPTIONS.map((option) => html`<button type="button" class="lang-option" lang=${option.lang} aria-pressed=${String(lang === option.lang)} onClick=${() => setLang(option.lang)}>${option.label}</button>`)}
  </div>`;
}
