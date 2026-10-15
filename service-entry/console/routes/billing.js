// /billing, C1 (07 §6.11): the legacy billing page embedded as an iframe.
// It is owner-only and local-only (05 §5.4 strictLocalBillingAdmin); anyone
// else sees the EmptyState. The native port replaces this file in CON-27.
//
// The iframe src is /billing/classic?embed=1&theme=<t>[&manager=<m>]. A theme
// change changes `src`, which reloads the frame, so the classic page picks up
// the new theme through its ?theme= handling (billing.html embed mode).

import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/page-header.js";
import { useRole, usePref, useT } from "../ui/hooks.js";
import { useServices } from "../ui/context.js";
import { html } from "../ui/html.js";

const THEMES = ["auto", "light", "dark"];
const MANAGER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** The embedded page's URL: host-relative, theme always set, manager only when valid. */
export function billingEmbedSrc({ theme, manager } = {}) {
  const params = new URLSearchParams();
  params.set("embed", "1");
  params.set("theme", THEMES.includes(theme) ? theme : "auto");
  const id = typeof manager === "string" ? manager.trim() : "";
  if (MANAGER_ID.test(id)) params.set("manager", id);
  return `/billing/classic?${params.toString()}`;
}

export default function Billing({ query } = {}) {
  const { t } = useT();
  const services = useServices();
  const role = useRole();
  const [theme] = usePref("theme");
  const local = services.bootstrap?.access?.local !== false;

  if (role !== "owner" || !local) {
    return html`<div class="stack" data-testid="billing.root">
      <${PageHeader} title=${t("shell.nav.billing")} />
      <${EmptyState} testid="billing.local-only" icon="lock" level=${2} title=${t("billing.localOnly.title")} body=${t("billing.localOnly.body")} action=${{ label: t("billing.localOnly.action"), href: "/overview" }} />
    </div>`;
  }
  const src = billingEmbedSrc({ theme, manager: query?.manager });
  return html`<div class="stack billing-embed" data-testid="billing.root">
    <${PageHeader} title=${t("shell.nav.billing")} />
    <iframe class="billing-frame" data-testid="billing.frame" src=${src} title=${t("billing.frame.title")} referrerpolicy="same-origin"></iframe>
  </div>`;
}
