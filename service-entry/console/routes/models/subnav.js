// The links between the Models pages (07 §6.4): Library, Discover, Downloads,
// Storage and Knowledge. Every Models page renders it under its header, so a
// page that is not in the build yet (Discover, Downloads and Knowledge arrive
// with their own packages) still has its link in place.

import { Button } from "../../components/button.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

const PAGES = Object.freeze([
  { id: "library", href: "/models", key: "hub.nav.library" },
  { id: "discover", href: "/models/discover", key: "hub.nav.discover" },
  { id: "downloads", href: "/models/downloads", key: "hub.nav.downloads" },
  { id: "storage", href: "/models/storage", key: "hub.nav.storage" },
  { id: "knowledge", href: "/models/knowledge", key: "hub.nav.knowledge" },
]);

export function ModelsNav({ current }) {
  const { t } = useT();
  return html`<nav class="row" aria-label=${t("hub.nav.label")} data-testid="models.nav">
    ${PAGES.map((page) => html`<${Button} key=${page.id} size="sm" variant=${page.id === current ? "default" : "ghost"} href=${page.href}
      aria-current=${page.id === current ? "page" : undefined} testid=${`models.nav.${page.id}`}>${t(page.key)}<//>`)}
  </nav>`;
}
