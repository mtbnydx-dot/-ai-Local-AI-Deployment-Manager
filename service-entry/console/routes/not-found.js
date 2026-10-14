// The page for a path no route matches (07 §3.3). The server falls back to the
// shell only for the console prefixes, so this is a mistyped sub-page or a
// bookmark to a page that moved.

import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useRoute } from "../ui/shell.js";

export default function NotFound() {
  const { t } = useT();
  const current = useRoute();
  return html`<div class="stack" data-testid="not-found.root">
    <${PageHeader} title=${t("shell.notFound.title")} subtitle=${current?.pathname || ""} />
    <${EmptyState} icon="search" level=${2} title=${t("shell.notFound.what")} body=${t("shell.notFound.body")} action=${{ label: t("shell.notFound.action"), href: "/overview" }} />
  </div>`;
}
