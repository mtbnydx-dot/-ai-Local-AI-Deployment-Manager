// CommandPreview (07 §4.4): the command a launch plan will run. One argv token
// per line with `<redacted>` kept as the server wrote it (a second pass hides
// anything that still looks like a secret); custom extra args are marked; the
// whole command copies as one line; the env sits in a table below. Nothing here
// ever shows a key: the plan the manager returns is already redacted.

import { commandView } from "../lib/launch-model.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useMemo } from "../ui/vendor.js";
import { useCopy } from "./code-block.js";
import { Icon } from "./icon.js";

// Quotes a token for the copied one-liner only when it needs it.
function quoted(token) {
  return /^[\w@%+=:,./<>-]+$/.test(token) ? token : `"${token.replace(/(["\\])/g, "\\$1")}"`;
}

/** @param command the plan's command { argv, env, labels }  @param extraArgs the user's custom tokens (highlighted) */
export function CommandPreview({ command, extraArgs = [], testid }) {
  const { t } = useT();
  const [state, copy] = useCopy();
  const view = useMemo(() => commandView(command, { extraArgs }), [command, extraArgs]);
  if (view.empty) return html`<p class="muted" data-testid=${testid || "command-preview.root"} data-empty="true">${t("common.command.empty")}</p>`;
  const oneLine = view.lines.map((line) => quoted(line.text)).join(" ");
  const status = state === "copied" ? t("common.copied") : state === "failed" ? t("common.copyFailed") : "";
  return html`<div class="command-preview stack-sm" data-testid=${testid || "command-preview.root"}>
    <div class="code-block">
      <ol class="command-lines" aria-label=${t("common.command.label")} tabindex="0" data-testid="command-preview.argv">
        ${view.lines.map((line, index) => html`<li key=${index} class=${`command-line mono${line.custom ? " command-custom" : ""}${line.redacted ? " command-redacted" : ""}`}
          data-custom=${line.custom ? "true" : "false"} data-testid="command-preview.line">
          <span>${line.text}</span>${" "}
          ${line.custom ? html`<span class="badge badge-info command-badge">${t("common.command.custom")}</span>` : null}
        </li>`)}
      </ol>
      <button type="button" class="btn btn-sm code-block-copy" onClick=${() => copy(oneLine)} data-state=${state} data-testid="command-preview.copy">
        <${Icon} name=${state === "copied" ? "check" : "copy"} />${state === "copied" ? t("common.copied") : t("common.command.copy")}
      </button>
      <span class=${state === "failed" ? "small text-danger" : "sr-only"} role="status" data-testid="command-preview.status">${status}</span>
    </div>
    ${view.env.length ? html`<div class="table-wrap"><table class="table" data-testid="command-preview.env">
      <caption class="sr-only">${t("common.command.env")}</caption>
      <thead><tr><th scope="col">${t("common.command.envName")}</th><th scope="col">${t("common.command.envValue")}</th></tr></thead>
      <tbody>${view.env.map((row) => html`<tr key=${row.name} data-testid="command-preview.env-row">
        <th scope="row" class="mono">${row.name}</th>
        <td class=${`mono${row.redacted ? " muted" : ""}`}>${row.value}</td>
      </tr>`)}</tbody>
    </table></div>` : null}
  </div>`;
}
