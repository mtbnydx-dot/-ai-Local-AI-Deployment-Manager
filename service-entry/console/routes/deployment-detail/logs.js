// The Logs tab of a deployment (07 §3.9): the LogViewer polls the manager's
// per-instance log every 2 s with `since` and appends without repeating lines.

import { logLinesOf, newLogLines } from "../../lib/deployments-model.js";
import { LogViewer, appendLines, RING_LIMIT } from "../../components/log-viewer.js";
import { useServices } from "../../ui/context.js";
import { html } from "../../ui/html.js";
import { useCallback, useRef } from "../../ui/vendor.js";

const SINCE_TAIL = RING_LIMIT;
const enc = encodeURIComponent;

export function LogsTab({ row }) {
  const { api } = useServices();
  const mirror = useRef([]);
  const { managerId, instanceId } = row;
  // Each poll asks for what came after the previous poll started. The reply is compared with the
  // end of what is already shown, so a repeated boundary is dropped (newLogLines), then appended.
  const load = useCallback(async ({ tail, cursor }) => {
    const startedAt = new Date().toISOString();
    const payload = await api.manager(managerId).get(`/instances/${enc(instanceId)}/logs`, { query: cursor ? { tail: SINCE_TAIL, since: cursor } : { tail } });
    const fresh = newLogLines(mirror.current, logLinesOf(payload));
    mirror.current = appendLines(mirror.current, fresh);
    return { lines: fresh, cursor: startedAt };
  }, [api, managerId, instanceId]);
  return html`<div data-testid="deploy.tab.logs"><${LogViewer} key=${row.fleetId} source=${{ kind: "instance", managerId, id: instanceId }} load=${load} /></div>`;
}
