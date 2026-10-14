// The page an owner-only route shows to a viewer who cannot pair from here
// (07 §5, §6.15): a browser on another machine, where owner actions are
// local-only (403 management_local_only). A viewer on this machine sees the
// PairingScreen instead.

import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";

export default function Forbidden() {
  const { t } = useT();
  return html`<div class="stack" data-testid="forbidden.root">
    <${PageHeader} title=${t("shell.forbidden.title")} />
    <${EmptyState} icon="lock" level=${2} title=${t("shell.forbidden.what")} body=${t("shell.forbidden.body")} action=${{ label: t("shell.forbidden.action"), href: "/overview" }} />
  </div>`;
}
