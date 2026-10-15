// The one-time token form of a job that waits for a token (waiting/auth, 03 §8):
// Resume sends it as `credential.hfToken` (loopback only). Loaded on first use
// (lazy.js), since it brings the form field with it.

import { Button } from "../../components/button.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { TokenFields } from "./hub-token.js";

export function TokenResume({ job, run, busy, onDone }) {
  const { t } = useT();
  const [token, setToken] = useState({ token: "", remember: false });
  return html`<div class="stack-sm" data-testid="download.token-resume">
    <${TokenFields} value=${token} onChange=${setToken} testid="download.token" />
    <div><${Button} size="sm" variant="primary" disabled=${!token.token.trim()} busy=${Boolean(busy[`${job.id}:resume`])}
      onClick=${async () => {
        await run.resume(job, { credential: { hfToken: token.token.trim(), remember: token.remember } });
        onDone?.();
      }} testid="download.token.resume">${t("hub.action.resume")}<//></div>
  </div>`;
}
