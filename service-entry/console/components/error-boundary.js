// ErrorBoundary (07 §4.4): one per route. A render error shows "This page
// crashed" with the error code, the request id when the error carries one, a
// copy-diagnostics button and a reload. Diagnostics hold no query string, no
// storage and no request body.

import { ServicesContext } from "../ui/context.js";
import { html } from "../ui/html.js";
import { useContext, useEffect, useErrorBoundary, useRef } from "../ui/vendor.js";
import { Button } from "./button.js";
import { useCopy } from "./code-block.js";

/** The text Copy diagnostics puts on the clipboard. */
export function diagnosticsOf(error) {
  const doc = globalThis.document;
  return JSON.stringify({
    code: error?.code || error?.name || "Error",
    message: String(error?.message || "").slice(0, 300),
    requestId: error?.requestId || null,
    path: globalThis.location?.pathname || null,
    build: doc?.querySelector?.('meta[name="console-build"]')?.content || null,
    at: new Date().toISOString(),
  }, null, 2);
}

function CrashPanel({ error }) {
  const services = useContext(ServicesContext);
  const t = services?.i18n?.t || ((key) => key);
  const [state, copy] = useCopy();
  const heading = useRef(null);
  useEffect(() => heading.current?.focus(), []);
  return html`<section class="card card-danger crash" role="alert" aria-labelledby="crash-title" data-testid="error-boundary.root">
    <h2 id="crash-title" tabindex="-1" ref=${heading}>${t("common.error.crashed")}</h2>
    <dl class="kv small">
      <dt>${t("common.error.code")}</dt><dd class="mono" data-testid="error-boundary.code">${error?.code || error?.name || "Error"}</dd>
      ${error?.requestId ? html`<dt>${t("common.error.requestId")}</dt><dd class="mono" data-testid="error-boundary.request-id">${error.requestId}</dd>` : null}
    </dl>
    <div class="row">
      <${Button} onClick=${() => copy(diagnosticsOf(error))} icon=${state === "copied" ? "check" : "copy"} testid="error-boundary.copy">${state === "copied" ? t("common.copied") : t("common.error.copyDiagnostics")}<//>
      <${Button} variant="primary" onClick=${() => globalThis.location.reload()} testid="error-boundary.reload">${t("common.error.reload")}<//>
    </div>
  </section>`;
}

/** @param onError (error) called once per caught error, for logging */
export function ErrorBoundary({ children, onError }) {
  const [error] = useErrorBoundary((caught) => {
    try {
      onError?.(caught);
    } catch {
      // The boundary must stay up even when its reporter throws.
    }
  });
  return error ? html`<${CrashPanel} error=${error} />` : children;
}
