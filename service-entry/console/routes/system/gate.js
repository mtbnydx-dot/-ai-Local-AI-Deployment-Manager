// The pre-P6 gate of the System pages (07 §6.13, 06 §11): settings, updates and
// ops need the platform backend (`features.platform`), and the doctor needs it
// for 06's checks. Without it the page shows the one EmptyState below, with the
// way back to the component table, instead of a half-working form. A route
// that answers endpoint_unavailable counts as missing too (the entry mounted
// the page's feature flag before the backend, or an older entry serves it).

import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { SystemNav } from "./subnav.js";

/** True when the bootstrap reports the platform backend. */
export function usePlatformOn() {
  const { bootstrap } = useServices();
  return Boolean(bootstrap?.features?.platform);
}

/** True for the error a route gives when the backend is not mounted. */
export function isUnavailable(error) {
  return error?.code === "endpoint_unavailable";
}

/** @param current the SystemNav id of the page  @param titleKey the page title's catalog key */
export function P6Required({ current, titleKey }) {
  const { t } = useT();
  return html`<div class="stack" data-testid="system.p6">
    <${PageHeader} title=${t(titleKey)} subtitle=${t("platform.p6.subtitle")} />
    <${SystemNav} current=${current} owner=${true} />
    <${EmptyState} icon="boxes" level=${2} title=${t("platform.p6.title")} body=${t("platform.p6.body")}
      action=${{ label: t("platform.p6.action"), href: "/system" }} testid="system.p6.empty" />
  </div>`;
}
