// Following a supervisor operation (06 §5.14, §7.3): a doctor fix and a
// settings Apply both answer 202 {opId}. The operation is read from
// GET /api/platform/operations/:opId every second until it is no longer
// running; `platform` events of kind "operation" for the same id read it at
// once. A read that fails (the entry is restarting, the supervisor is gone)
// keeps the last state, says the connection was lost and tries again.

import { ProgressRow } from "../../components/progress-row.js";
import { StatusBadge } from "../../components/status-badge.js";
import { Button } from "../../components/button.js";
import { tk } from "../../lib/i18n.js";
import { useServices } from "../../ui/context.js";
import { useEvent, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef, useState } from "../../ui/vendor.js";

const POLL_MS = 1000;
const RETRY_MS = 2000;
const LOG_LINES = 8;
const TONE = Object.freeze({ running: "info", ok: "ok", failed: "error", unknown: "neutral" });

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An operation as the supervisor reports it ({opId, kind, state, progress, log, result}), made safe to render. */
export function normalizeOperation(raw) {
  const body = isPlainObject(raw?.operation) ? raw.operation : isPlainObject(raw) ? raw : {};
  const state = ["running", "ok", "failed"].includes(body.state) ? body.state : "running";
  const progress = Number(body.progress);
  const result = isPlainObject(body.result) ? body.result : null;
  return {
    opId: typeof body.opId === "string" ? body.opId : "",
    kind: typeof body.kind === "string" ? body.kind : "",
    state,
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null,
    log: Array.isArray(body.log) ? body.log.map(String).slice(-LOG_LINES) : [],
    result: result ? { code: typeof result.code === "string" ? result.code : "", message: typeof result.message === "string" ? result.message : "" } : null,
  };
}

/** The operation `opId`, kept current while mounted. onDone(op) fires once when it stops running. */
export function useOperation(opId, onDone) {
  const { api } = useServices();
  const [op, setOp] = useState(null);
  const [lost, setLost] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const poke = useRef(() => {});

  useEffect(() => {
    setOp(null);
    setLost(false);
    if (!opId) return undefined;
    let alive = true;
    let timer = null;
    let reading = false;
    async function read() {
      if (!alive || reading) return;
      reading = true;
      globalThis.clearTimeout(timer);
      let next = POLL_MS;
      try {
        const answer = normalizeOperation(await api.get(`/api/platform/operations/${encodeURIComponent(opId)}`));
        if (!alive) return;
        setLost(false);
        setOp(answer);
        if (answer.state !== "running") {
          done.current?.(answer);
          return;
        }
      } catch (error) {
        if (!alive) return;
        if (error?.code === "operation_unknown") {
          setOp({ opId, kind: "", state: "unknown", progress: null, log: [], result: null });
          return;
        }
        setLost(true);
        next = RETRY_MS;
      } finally {
        reading = false;
      }
      if (alive) timer = globalThis.setTimeout(read, next);
    }
    poke.current = read;
    read();
    return () => {
      alive = false;
      globalThis.clearTimeout(timer);
      poke.current = () => {};
    };
  }, [opId]);

  useEvent("platform", (envelope) => {
    const data = envelope?.data;
    if (data?.kind === "operation" && data.opId === opId) poke.current();
  });

  return { op, lost };
}

/** One operation: state, progress and the last log lines. */
export function OperationPanel({ opId, label, onDone, onDismiss, testid }) {
  const { t, has } = useT();
  const { op, lost } = useOperation(opId, onDone);
  const state = op?.state || "running";
  const percent = op?.progress === null || op?.progress === undefined ? null : op.progress * 100;
  const failure = op?.state === "failed" && op.result ? [op.result.code, op.result.message].filter(Boolean).join(": ") : "";
  return html`<div class="op-panel stack-sm" data-state=${state} data-testid=${testid || "operation.root"}>
    <div class="row">
      <${StatusBadge} status=${state === "running" && !op ? "loading" : TONE[state] || "unknown"} label=${has(tk("platform.operation.state.", state)) ? t(tk("platform.operation.state.", state)) : state} testid="operation.state" />
      <strong class="grow" data-testid="operation.label">${label}</strong>
      ${state !== "running" && onDismiss ? html`<${Button} size="sm" variant="ghost" onClick=${onDismiss} testid="operation.dismiss">${t("platform.operation.dismiss")}<//>` : null}
    </div>
    ${state === "running" ? html`<${ProgressRow} label=${label} percent=${percent} testid="operation.progress" />` : null}
    ${lost ? html`<p class="small muted" role="status" data-testid="operation.lost">${t("platform.operation.lost")}</p>` : null}
    ${failure ? html`<p class="field-error" role="alert" data-testid="operation.failure">${failure}</p>` : null}
    ${op?.log?.length ? html`<pre class="op-log" tabindex="0" aria-label=${t("platform.operation.log")} data-user-content data-testid="operation.log">${op.log.join("\n")}</pre>` : null}
  </div>`;
}
