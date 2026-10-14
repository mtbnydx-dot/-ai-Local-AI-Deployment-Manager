// Sidebar (07 §4.4, §5): the four navigation groups. Links carry
// aria-current="page" for the section on screen. Collapsed mode shows icons
// with tooltips and keeps each accessible name. A viewer sees a lock on the
// entries only an owner can open; they stay links, and the page itself
// explains how to pair (§5).

import { isLockedFor, navHref } from "../data/nav.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

function NavLink({ item, role, active, collapsed }) {
  const { t } = useT();
  const label = t(item.labelKey);
  const locked = isLockedFor(item, role);
  return html`<li>
    <a class=${`nav-link${active ? " is-active" : ""}`} href=${navHref(item, role)} aria-current=${active ? "page" : undefined} title=${collapsed ? label : undefined}
      data-nav=${item.id} data-locked=${locked ? "true" : undefined} data-testid=${`sidebar.link.${item.id}`}>
      <${Icon} name=${item.icon} />
      <span class=${collapsed ? "sr-only" : "nav-label"}>${label}</span>
      ${locked ? html`<${Icon} name="lock" size="sm" class="nav-lock" /><span class="sr-only">${t("shell.ownerOnly")}</span>` : null}
    </a>
  </li>`;
}

// groups from data/nav.js; section is the route's sidebar entry; drawer renders the off-canvas copy (never collapsed).
export function Sidebar({ groups, role = "viewer", section = null, collapsed = false, onToggle, drawer = false, testid }) {
  const { t } = useT();
  const compact = collapsed && !drawer;
  const toggle = { variant: "ghost", size: "sm", iconOnly: true, label: t("shell.sidebar.toggle"), onClick: onToggle, testid: "sidebar.toggle" };
  return html`<nav class=${`sidebar${compact ? " is-collapsed" : ""}`} aria-label=${t("shell.navLabel")} data-testid=${testid || "sidebar.root"}>
    <a class="brand" href="/overview" title=${compact ? t("shell.product") : undefined} data-testid="sidebar.brand">
      <span class="brand-mark" aria-hidden="true">AI</span>
      <span class=${compact ? "sr-only" : "brand-name"}>${t("shell.product")}</span>
    </a>
    <div class="sidebar-groups">
      ${groups.map((group) => html`<div class="nav-group" key=${group.id}>
        <p class=${compact ? "sr-only" : "nav-heading"} id=${`nav-${group.id}${drawer ? "-d" : ""}`}>${t(group.labelKey)}</p>
        <ul aria-labelledby=${`nav-${group.id}${drawer ? "-d" : ""}`}>
          ${group.items.map((item) => html`<${NavLink} key=${item.id} item=${item} role=${role} active=${section === item.id} collapsed=${compact} />`)}
        </ul>
      </div>`)}
    </div>
    <div class="sidebar-foot">
      <a class="nav-link nav-small" href="/classic" data-testid="sidebar.classic"><span class=${compact ? "sr-only" : "nav-label"}>${t("shell.classic")}</span><${Icon} name="external-link" size="sm" /></a>
      ${drawer ? null : collapsed
        ? html`<${Button} ...${toggle} icon="panel-left-open" aria-expanded="false" />`
        : html`<${Button} ...${toggle} icon="panel-left-close" aria-expanded="true" />`}
    </div>
  </nav>`;
}
