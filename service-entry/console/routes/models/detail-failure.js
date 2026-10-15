// The inline "could not load" notice with a Retry button, shared by the lazy
// tabs of the model detail page.

import { describeError } from "../../lib/api.js";
import { Button } from "../../components/button.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

export function Failure({ error, onRetry, testid }) {
  const { i18n } = useServices();
  const { t } = useT();
  return html`<div class="notice notice-danger" role="alert" data-testid=${testid}>
    <span class="grow" data-user-content="">${describeError(error, i18n)}</span>
    <${Button} size="sm" onClick=${onRetry}>${t("hub.library.retry")}<//>
  </div>`;
}
