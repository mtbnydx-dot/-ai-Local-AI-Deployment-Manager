// ConnectionBanner (07 §4.4, §3.6): says when live updates stopped. `polling`
// (info) means SSE failed but /api/events/recent still answers; `offline`
// (error) means neither does, and offers a retry that opens a new stream.
// It ports the classic console's connection-status behaviour. The banner
// itself is the only live region; data panels never carry aria-live.

import { useT, useFormat } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

// state connecting|open|polling|offline; lastOkAt is a millisecond timestamp or an ISO string.
export function ConnectionBanner({ state, lastOkAt, onRetry, testid }) {
  const { t } = useT();
  const fmt = useFormat();
  if (state === "polling") {
    return html`<div class="notice" role="status" data-state="polling" data-testid=${testid || "connection-banner.root"}>
      <${Icon} name="info" /><span class="grow">${t("shell.conn.polling")}</span>
    </div>`;
  }
  if (state !== "offline") return null;
  const when = lastOkAt ? fmt.time(lastOkAt) : "—";
  return html`<div class="notice notice-danger" role="alert" data-state="offline" data-testid=${testid || "connection-banner.root"}>
    <${Icon} name="circle-x" /><span class="grow">${t("shell.conn.offline", { time: when })}</span>
    <${Button} size="sm" onClick=${onRetry} testid="connection-banner.retry">${t("shell.conn.retry")}<//>
  </div>`;
}
