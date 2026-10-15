// FitSolver (07 §4.4, §6.3 step 3, 02 §10.8 and §18 R-UI-3): ties the context
// length to the memory it needs.
//
// With a grid from POST /api/models/:id/fit-grid it draws KV dtype × concurrency
// as a table whose cells hold the largest context that still fits. A cell says
// it in color and text (fits, uses RAM, no fit) and why the next step fails
// (the model's own limit, VRAM, RAM, the engine); clicking one opens a
// DiffTable with the three settings it changes, and Apply hands them to
// onApply. Without a grid (the endpoint answers 404, or the request failed)
// the 02 FitResult `suggestions[]` are Apply chips with their `deltaMb`
// ("fp8 KV saves 8 GiB").
//
// <FitSolver grid fit current catalog loading unavailable error onApply(values) onRetry />
//   grid     the fit-grid answer, or null
//   fit      a FitResult / LaunchPlan.memory (its suggestions feed the chips)
//   current  the effective values { id: value | { value, source } } the diff starts from
//   onApply  ({ catalogId: value }) the settings to set; the page stores them as the user's own

import { diffValues } from "../lib/wizard-state.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Button } from "./button.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { DiffTable } from "./diff-table.js";
import { Icon } from "./icon.js";
import { Skeleton } from "./skeleton.js";
import { useState } from "../ui/vendor.js";

const MIB = 1048576;
const LIMIT_KEYS = Object.freeze({
  native: "models.fit.limited.native",
  vram: "models.fit.limited.vram",
  ram: "models.fit.limited.ram",
  engine: "models.fit.limited.engine",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** The catalog ids that hold the KV cache dtype of an engine (llama.cpp keeps K and V apart). */
export function kvParamsFor(engineId) {
  return engineId === "llamacpp" ? ["llamacpp.cacheTypeK", "llamacpp.cacheTypeV"] : ["kvCacheDtype"];
}

/** The KV dtypes to ask the grid about: the catalog's choices in the preferred order, at most `limit` (02 allows 4). */
export function gridKvDtypes(engineId, catalog, limit = 3) {
  const preferred = engineId === "llamacpp" ? ["f16", "q8_0", "q4_0"] : ["auto", "fp8", "fp8_e5m2"];
  const [param] = kvParamsFor(engineId);
  const choices = list(list(catalog?.params).find((item) => item?.id === param)?.choices).map((choice) => (isObject(choice) ? choice.value : choice)).filter((value) => typeof value === "string");
  if (!choices.length) return preferred.slice(0, 2);
  const ordered = [...preferred.filter((value) => choices.includes(value)), ...choices.filter((value) => !preferred.includes(value))];
  return ordered.slice(0, limit);
}

/** The grid as rows: { kvDtypes, concurrency, cell(kvDtype, concurrency), native } (cells keep the server's fields). */
export function gridView(grid) {
  const cells = list(grid?.cells).filter((cell) => isObject(cell) && typeof cell.kvDtype === "string" && Number.isFinite(Number(cell.concurrency)));
  const kvDtypes = [...new Set(cells.map((cell) => cell.kvDtype))];
  const concurrency = [...new Set(cells.map((cell) => Number(cell.concurrency)))].sort((a, b) => a - b);
  const byKey = new Map(cells.map((cell) => [`${cell.kvDtype}|${Number(cell.concurrency)}`, cell]));
  return { kvDtypes, concurrency, cell: (kvDtype, count) => byKey.get(`${kvDtype}|${count}`) || null, native: Number(grid?.native) || null };
}

/** "fits" | "spill" | "none": what a cell says (no context at all fits, or the cell is `fail`, is none). */
export function cellTone(cell) {
  const max = Number(cell?.maxContext);
  if (!Number.isFinite(max) || max <= 0 || cell?.status === "fail") return "none";
  return cell?.spill === true || cell?.status === "warn" ? "spill" : "fits";
}

/** The settings a cell stands for, by catalog id. */
export function cellValues(engineId, cell) {
  const values = { contextLength: Number(cell.maxContext), concurrency: Number(cell.concurrency) };
  for (const param of kvParamsFor(engineId)) values[param] = cell.kvDtype;
  return values;
}

/** The suggestion chips of a FitResult: [{ code, param, to, deltaMb, message }]; entries without a param are dropped. */
export function suggestionChips(fit) {
  return list(fit?.suggestions).filter((item) => isObject(item) && typeof item.param === "string" && item.param && item.to !== undefined)
    .map((item) => ({ code: String(item.code || item.param), param: item.param, to: item.to, deltaMb: Number.isFinite(Number(item.deltaMb)) ? Number(item.deltaMb) : null, message: item.message }));
}

function plain(entry) {
  return isObject(entry) && Object.hasOwn(entry, "value") ? entry.value : entry;
}

function shortTokens(n, fmt) {
  if (n >= 1048576 && n % 1048576 === 0) return `${fmt.number(n / 1048576, 0)}M`;
  if (n >= 1024) return `${fmt.number(n / 1024, n % 1024 === 0 ? 0 : 1)}K`;
  return fmt.number(n, 0);
}

function Cell({ cell, current, onOpen }) {
  const { t } = useT();
  const fmt = useFormat();
  const tone = cellTone(cell);
  const max = Number(cell.maxContext);
  const limit = LIMIT_KEYS[cell.limitedBy] ? t(LIMIT_KEYS[cell.limitedBy]) : "";
  const label = tone === "none" ? t("models.fit.cellNone") : tone === "spill" ? t("models.fit.cellSpill") : t("models.fit.cellFits");
  return html`<button type="button" class=${`fit-cell fit-cell-${tone}`} disabled=${tone === "none"} data-testid="fit-solver.cell" data-tone=${tone} data-kv=${cell.kvDtype}
    data-concurrency=${cell.concurrency} data-max=${tone === "none" ? 0 : max} data-limit=${cell.limitedBy || ""} data-current=${current ? "true" : "false"}
    aria-label=${t("models.fit.cellLabel", { context: tone === "none" ? "—" : fmt.tokens(max), state: label, limit })}
    onClick=${() => onOpen(cell)}>
    <strong class="num">${tone === "none" ? "—" : shortTokens(max, fmt)}</strong>
    <span class="xsmall"><${Icon} name=${tone === "none" ? "circle-x" : tone === "spill" ? "triangle-alert" : "circle-check"} /> ${label}</span>
    ${limit ? html`<span class="xsmall muted">${limit}</span>` : null}
    ${cell.truncated ? html`<span class="xsmall muted">${t("models.fit.cellPartial")}</span>` : null}
  </button>`;
}

function Chips({ fit, onApply, unavailable }) {
  const { t, pick } = useT();
  const fmt = useFormat();
  const chips = suggestionChips(fit);
  return html`<div class="stack-sm" data-testid="fit-solver.suggestions">
    ${unavailable ? html`<p class="small muted" data-testid="fit-solver.unavailable">${t("models.fit.solver.unavailable")}</p>` : null}
    ${chips.length ? html`<ul class="row fit-chips">
      ${chips.map((chip) => {
        const delta = chip.deltaMb;
        return html`<li key=${chip.code}><${Button} size="sm" onClick=${() => onApply?.({ [chip.param]: chip.to })} testid="fit-solver.chip" data-code=${chip.code} data-param=${chip.param}>
          <span data-user-content="">${pick(chip.message) || `${chip.param} → ${String(chip.to)}`}</span>
          ${delta ? html`<span class=${`num ${delta < 0 ? "fit-delta-save" : "fit-delta-cost"}`} data-testid="fit-solver.delta" data-delta=${delta}>${delta < 0 ? "−" : "+"}${fmt.bytes(Math.abs(delta) * MIB, { unit: "GiB" })}</span>` : null}
        <//></li>`;
      })}
    </ul>` : html`<p class="small muted" data-testid="fit-solver.none">${t("models.fit.solver.noSuggestions")}</p>`}
  </div>`;
}

export function FitSolver({ grid = null, fit = null, current = {}, catalog = null, loading = false, unavailable = false, error = null, onApply, onRetry, testid }) {
  const { t, locale } = useT();
  const fmt = useFormat();
  const [picked, setPicked] = useState(null);
  const view = grid ? gridView(grid) : null;
  const engineId = grid?.engineId || "";
  const currentKv = plain(current?.[kvParamsFor(engineId)[0]]);
  const currentConcurrency = Number(plain(current?.concurrency));
  const values = picked ? cellValues(engineId, picked) : null;
  const rows = values ? diffValues(current, values, catalog, { locale }) : [];
  return html`<div class="fit-solver stack-sm" data-testid=${testid || "fit-solver.root"} data-mode=${view ? "grid" : "suggestions"}>
    <h3 class="fit-solver-title">${t("models.fit.solver.title")}</h3>
    ${loading ? html`<div aria-busy="true" data-testid="fit-solver.loading"><${Skeleton} shape="line" rows=${3} /></div>` : null}
    ${!loading && view && view.cell ? html`<div class="stack-sm">
      <p class="small muted">${t("models.fit.solver.lead", { native: view.native ? fmt.tokens(view.native) : "—" })}</p>
      <div class="table-wrap"><table class="table fit-grid" data-testid="fit-solver.grid">
        <caption class="sr-only">${t("models.fit.solver.caption")}</caption>
        <thead><tr><th scope="col">${t("models.fit.solver.rows")}</th>${view.kvDtypes.map((kv) => html`<th key=${kv} scope="col" data-kv=${kv}><code class="code-inline">${kv}</code></th>`)}</tr></thead>
        <tbody>${view.concurrency.map((count) => html`<tr key=${count}>
          <th scope="row">${t("models.fit.solver.concurrency", { count })}</th>
          ${view.kvDtypes.map((kv) => {
            const cell = view.cell(kv, count);
            return html`<td key=${kv}>${cell ? html`<${Cell} cell=${cell} current=${currentConcurrency === count && String(currentKv ?? "") === kv} onOpen=${setPicked} />` : "—"}</td>`;
          })}
        </tr>`)}</tbody>
      </table></div>
    </div>` : null}
    ${!loading && !view ? html`<${Chips} fit=${fit} onApply=${onApply} unavailable=${unavailable} />` : null}
    ${!loading && !view && error ? html`<div class="notice notice-warn" role="status" data-testid="fit-solver.error">
      <span class="grow">${t("models.fit.solver.failed")}</span>
      ${onRetry ? html`<${Button} size="sm" onClick=${onRetry} testid="fit-solver.retry">${t("models.wizard.plan.retry")}<//>` : null}
    </div>` : null}
    <${ConfirmDialog} open=${Boolean(picked)} testid="fit-solver.dialog" title=${t("models.fit.solver.applyTitle", { context: picked ? fmt.tokens(Number(picked.maxContext)) : "" })}
      body=${picked ? html`<div class="stack-sm"><p>${t("models.fit.solver.applyBody")}</p><${DiffTable} rows=${rows} testid="fit-solver.diff" /></div>` : ""}
      confirmLabel=${t("models.fit.solver.apply")} cancelLabel=${t("common.cancel")}
      onConfirm=${() => onApply?.(values)}
      onClose=${() => setPicked(null)} />
  </div>`;
}
