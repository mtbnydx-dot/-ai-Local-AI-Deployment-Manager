// The component log drawer of /system (06 §5.9, 07 §4.4), loaded when the
// first Logs action opens it so the page itself stays small (07 §11). The
// LogViewer polls GET /api/platform/components/:id/logs?tail=.

import { Drawer } from "../../components/drawer.js";
import { LogViewer } from "../../components/log-viewer.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

const LOGS_PREFIX = "logs:";

export function ComponentLogs({ row, onClose }) {
  const { t } = useT();
  const title = t("platform.system.logs.title", { component: row.label });
  return html`<${Drawer} open width=${840} title=${title} urlId=${`${LOGS_PREFIX}${row.id}`} onClose=${onClose} testid="system.logs">
    <${LogViewer} key=${row.id} source=${{ kind: "component", id: row.id }} label=${title} testid="system.log-viewer" />
  <//>`;
}
