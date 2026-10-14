// ui-kit section: stat tiles, progress, steps, capacity, tables, code, empty
// and loading states, the QR code and the error boundary.

import { tk } from "../../../lib/i18n.js";
import { useT } from "../../../ui/hooks.js";
import { html } from "../../../ui/html.js";
import { useState } from "../../../ui/vendor.js";
import { Button } from "../../../components/button.js";
import { Card } from "../../../components/card.js";
import { CodeBlock } from "../../../components/code-block.js";
import { DiffTable } from "../../../components/diff-table.js";
import { EmptyState } from "../../../components/empty-state.js";
import { ErrorBoundary } from "../../../components/error-boundary.js";
import { ProgressRow } from "../../../components/progress-row.js";
import { QrCode } from "../../../components/qr-code.js";
import { Skeleton } from "../../../components/skeleton.js";
import { StackedBar } from "../../../components/stacked-bar.js";
import { StatTile } from "../../../components/stat-tile.js";
import { Stepper } from "../../../components/stepper.js";
import { DIFF, GIB, PARTS, STEPS } from "../../../data/ui-kit-fixtures.js";

function Bomb({ armed }) {
  if (armed) throw Object.assign(new Error("ui-kit test crash"), { code: "ui_kit_crash", requestId: "req_uikit" });
  return null;
}

export default function DisplaySection() {
  const { t } = useT();
  const [showQr, setShowQr] = useState(false);
  const [armed, setArmed] = useState(false);
  return html`
    <${Card} title=${t("uikit.tiles")}>
      <div class="grid-auto">
        <${StatTile} label=${t("uikit.tile.tokens")} value="38.6" unit="tok/s" window=${t("common.window.1h")} delta=${{ value: 12, goodWhen: "up" }} sparkline=${[3, 5, 4, 8, 7, 9]} />
        <${StatTile} label=${t("uikit.tile.errors")} value=${4} denominator=${{ value: 120, label: t("uikit.tile.requests") }} window=${t("common.window.1h")} delta=${{ value: 2, goodWhen: "down" }} status="warn" />
        <${StatTile} label=${t("uikit.tile.empty")} value=${null} window=${t("common.window.1h")} href="/overview" />
      </div>
    <//>

    <${Card} title=${t("uikit.progress")}>
      <div class="stack">
        <${ProgressRow} label="model.gguf" bytesDone=${5 * GIB} bytesTotal=${12 * GIB} speedBps=${1.2 * GIB} etaSec=${180} phase=${t("uikit.phase")} />
        <${ProgressRow} label="index" percent=${null} />
        <${Stepper} steps=${STEPS.map((step) => ({ ...step, label: t(tk("common.step.", step.state)) }))} label=${t("uikit.stepper")} />
        <${Stepper} steps=${STEPS.slice(0, 3).map((step) => ({ ...step, label: t(tk("common.step.", step.state)), detail: t("uikit.detail") }))} orientation="vertical" label=${t("uikit.stepperVertical")} />
        <${StackedBar} total=${80 * GIB} parts=${PARTS} />
      </div>
    <//>

    <${Card} title=${t("uikit.data")}>
      <div class="stack">
        <${DiffTable} rows=${DIFF} caption=${t("uikit.diff")} />
        <${CodeBlock} code=${"platform admin pair\nplatform doctor --fresh"} language="shell" />
        <${EmptyState} icon="search" title=${t("uikit.empty.title")} body=${t("uikit.empty.body")} action=${{ label: t("uikit.empty.action"), href: "/overview" }} />
        <div aria-busy="true"><${Skeleton} shape="line" rows=${3} /><${Skeleton} shape="tile" /><${Skeleton} shape="table" rows=${2} /></div>
      </div>
    <//>

    <${Card} title=${t("uikit.misc")}>
      <div class="row">
        <${Button} onClick=${() => setShowQr(!showQr)} testid="uikit.toggle-qr">${t("uikit.toggleQr")}<//>
        <${Button} variant="danger" onClick=${() => setArmed(true)} testid="uikit.crash">${t("uikit.crash")}<//>
      </div>
      ${showQr ? html`<${QrCode} text="https://example.invalid/pair#code=0000" label=${t("uikit.qrLabel")} />` : null}
      <${ErrorBoundary}><${Bomb} armed=${armed} /><//>
    <//>`;
}
