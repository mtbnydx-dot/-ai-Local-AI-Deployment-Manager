// The README tab of the model detail page (07 §6.4): the repository's README
// (GET /api/hub/repos/:provider/:owner/:name/readme) in the MarkdownViewer,
// which never loads remote images. A local folder shows the README of the
// repository its provenance names, if any.

import { repoPath } from "../../lib/library-model.js";
import { EmptyState } from "../../components/empty-state.js";
import { MarkdownViewer } from "../../components/markdown-viewer.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { Failure } from "./detail-failure.js";

export function ReadmeTab({ target }) {
  const { api } = useServices();
  const { t } = useT();
  const query = useQuery(["hub", "repos", target?.provider, target?.owner, target?.name, "readme"], () => api.get(`${repoPath(target)}/readme`), { ttlMs: 300000, enabled: Boolean(target) });
  if (!target) return html`<${EmptyState} testid="detail.readme.none" title=${t("hub.detail.readme.none")} body=${t("hub.detail.readme.noneBody")} />`;
  if (query.error && !query.data) return html`<${Failure} error=${query.error} onRetry=${() => query.refetch()} testid="detail.readme.error" />`;
  if (!query.data) return html`<div aria-busy="true"><${Skeleton} shape="line" rows=${6} /></div>`;
  if (!query.data.markdown) return html`<p class="muted">${t("hub.detail.readme.empty")}</p>`;
  return html`<div class="stack-sm" data-testid="detail.readme">
    ${query.data.truncated ? html`<p class="small muted">${t("hub.detail.readme.truncated")}</p>` : null}
    <${MarkdownViewer} source=${query.data.markdown} allowImages="none" />
  </div>`;
}
