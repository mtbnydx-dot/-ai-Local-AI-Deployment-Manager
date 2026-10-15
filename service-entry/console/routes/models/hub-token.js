// The one-time Hugging Face token fields (03 §12), shared by the plan sheet and
// the Downloads page's "enter token" resume. The token is kept in this
// component's state only; it is sent as `credential.hfToken` over loopback and
// never stored by the console. The hub accepts it from a browser on this PC
// only (403 `token_requires_local` otherwise), which the note says.

import { FormField } from "../../components/form-field.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

/** @param value { token, remember }  @param onChange(next)  @param onCommit() the token field lost focus  @param localOnly show the "this PC only" note */
export function TokenFields({ value, onChange, onCommit, localOnly = false, testid = "token" }) {
  const { t } = useT();
  return html`<div class="stack-sm" data-testid=${testid}>
    <${FormField} label=${t("hub.token.label")} testid=${`${testid}.field`}>
      ${(control) => html`<input ...${control} class="input" type="password" autocomplete="off" spellcheck="false" value=${value.token}
        data-testid=${`${testid}.input`} onBlur=${() => onCommit?.()} onInput=${(event) => onChange({ ...value, token: event.currentTarget.value })} />`}
    <//>
    <label class="row-nowrap"><input type="checkbox" checked=${value.remember} data-testid=${`${testid}.remember`}
      onChange=${(event) => onChange({ ...value, remember: event.currentTarget.checked })} /><span class="small">${t("hub.token.remember")}</span></label>
    ${localOnly ? html`<p class="small muted" role="status" data-testid=${`${testid}.local`}>${t("hub.token.localOnly")}</p>` : null}
  </div>`;
}
