// The links between the System pages (06 §11, 07 §6.13). A viewer reads only
// the component table and the preferences; the other pages are the owner's,
// so their links are left out instead of leading to the pairing screen.

import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { Button } from "../../components/button.js";

const PAGES = Object.freeze([
  { id: "components", href: "/system", key: "platform.system.nav.components", owner: false },
  { id: "doctor", href: "/system/doctor", key: "platform.system.nav.doctor", owner: true },
  { id: "settings", href: "/system/settings", key: "platform.system.nav.settings", owner: true },
  { id: "updates", href: "/system/updates", key: "platform.system.nav.updates", owner: true },
  { id: "ops", href: "/system/ops", key: "platform.system.nav.ops", owner: true },
  { id: "preferences", href: "/system/preferences", key: "platform.system.nav.preferences", owner: false },
]);

/** The pages shown to a role, in order. */
export function systemPages(owner) {
  return PAGES.filter((page) => owner || !page.owner);
}

export function SystemNav({ current, owner = false }) {
  const { t } = useT();
  return html`<nav class="row" aria-label=${t("platform.system.nav.label")} data-testid="system.nav">
    ${systemPages(owner).map((page) => html`<${Button} key=${page.id} size="sm" variant=${page.id === current ? "default" : "ghost"} href=${page.href}
      aria-current=${page.id === current ? "page" : undefined} testid=${`system.nav.${page.id}`}>${t(page.key)}<//>`)}
  </nav>`;
}
