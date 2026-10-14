// PageHeader (07 §4.4): the route's one <h1>. It takes programmatic focus
// (tabindex -1) when the router moves to a new page; at most one action may
// be primary.

import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { toChildArray } from "../ui/vendor.js";
import { Icon } from "./icon.js";

let warned = false;

// breadcrumbs [{ label, href? }]; at most one primary action.
export function PageHeader({ title, subtitle, breadcrumbs, actions, meta, testid }) {
  const { t } = useT();
  if (!warned && toChildArray(actions).filter((node) => node?.props?.variant === "primary").length > 1) {
    warned = true;
    globalThis.console?.warn?.("PageHeader: at most one primary action");
  }
  const crumbs = Array.isArray(breadcrumbs) ? breadcrumbs : [];
  return html`<header class="page-header" data-testid=${testid || "page-header.root"}>
    <div class="page-header-text">
      ${crumbs.length ? html`<nav aria-label=${t("common.breadcrumb")}><ol class="breadcrumbs">
        ${crumbs.map((crumb, index) => html`<li key=${index}>
          ${crumb.href && index < crumbs.length - 1 ? html`<a href=${crumb.href}>${crumb.label}</a>` : html`<span aria-current=${index === crumbs.length - 1 ? "page" : undefined}>${crumb.label}</span>`}
          ${index < crumbs.length - 1 ? html`<${Icon} name="chevron-right" size="sm" />` : null}
        </li>`)}
      </ol></nav>` : null}
      <h1 tabindex="-1" data-testid="page-header.title">${title}</h1>
      ${subtitle ? html`<p class="page-header-sub">${subtitle}</p>` : null}
      ${meta ? html`<div class="row page-header-meta">${meta}</div>` : null}
    </div>
    ${actions ? html`<div class="page-header-actions">${actions}</div>` : null}
  </header>`;
}
