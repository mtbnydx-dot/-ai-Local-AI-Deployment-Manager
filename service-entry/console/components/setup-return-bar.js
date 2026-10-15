// SetupReturnBar (07 §6.14, CON-25): the "Back to setup" bar the shell shows
// on every page opened with ?from=setup, so the owner can leave a linked page
// (storage, Deploy wizard, access) and come back to the first-run steps.

import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

/** @param query the router's query object of the page on screen */
export function SetupReturnBar({ query }) {
  const { t } = useT();
  if (query?.from !== "setup") return null;
  return html`<div class="notice setup-return" role="navigation" aria-label=${t("platform.setup.back")} data-testid="setup-return-bar">
    <${Icon} name="info" /><span class="grow">${t("platform.setup.backHint")}</span>
    <${Button} size="sm" href="/setup" testid="setup-return-bar.link">${t("platform.setup.back")}<//>
  </div>`;
}
