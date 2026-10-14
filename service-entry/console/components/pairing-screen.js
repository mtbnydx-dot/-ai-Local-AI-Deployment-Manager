// PairingScreen (07 §4.4, §6.15, 05 §5.2): shown for role `none`, after a 401
// admin_session_required and on owner-only routes for a viewer. It never asks
// for a password or a code: a pairing code arrives only through `#pair=`
// (lib/boot-pair.js). The person runs `pairCommand` in a terminal on this
// machine, then presses Retry, which re-reads /api/session.

import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { CodeBlock } from "./code-block.js";
import { Icon } from "./icon.js";

// reason unpaired|invalid|expired; onRetry resolves true when the browser is paired now; onDismiss is optional.
export function PairingScreen({ reason = "unpaired", autoPairAvailable = false, pairCommand = "platform admin pair", onRetry, onDismiss, standalone = false, testid }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const heading = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function retry() {
    setBusy(true);
    setFailed(false);
    let paired = false;
    try {
      paired = Boolean(await onRetry?.());
    } catch {
      paired = false;
    }
    if (alive.current) {
      setBusy(false);
      setFailed(!paired);
    }
  }

  const problem = reason === "invalid" ? t("pair.invalid") : reason === "expired" ? t("pair.expired") : "";
  const content = html`<section class="card pairing" aria-labelledby="pair-title" data-reason=${reason} data-testid=${testid || "pairing-screen.root"}>
    <div class="row-nowrap pairing-head"><${Icon} name="lock" size="lg" /><h1 id="pair-title" tabindex="-1" ref=${heading}>${t("pair.title")}</h1></div>
    ${problem ? html`<p class="notice notice-danger" role="alert" data-testid="pairing-screen.problem"><${Icon} name="circle-x" />${problem}</p>` : null}
    <p data-testid="pairing-screen.body">${t("pair.body", { cmd: pairCommand })}</p>
    ${autoPairAvailable ? html`<p class="muted small">${t("pair.auto")}</p>` : null}
    <div class="stack-sm">
      <p class="small muted">${t("pair.cmd")}</p>
      <${CodeBlock} code=${pairCommand} testid="pairing-screen.command" />
    </div>
    <div class="row">
      <${Button} variant="primary" busy=${busy} onClick=${retry} testid="pairing-screen.retry">${t("pair.retry")}<//>
      ${onDismiss ? html`<${Button} onClick=${onDismiss} testid="pairing-screen.dismiss">${t("pair.dismiss")}<//>` : null}
    </div>
    ${failed ? html`<p class="field-error" role="alert" data-testid="pairing-screen.still">${t("pair.stillUnpaired")}</p>` : null}
  </section>`;
  return standalone ? html`<main id="main" class="pairing-page" tabindex="-1">${content}</main>` : content;
}
