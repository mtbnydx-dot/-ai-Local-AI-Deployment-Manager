// TimeRangePicker (07 §4.4, §6.7): preset buttons (15 m … 30 d) and a custom
// range of two `datetime-local` inputs. The component is controlled
// (`value`, `onChange(value, { compare })`); useTimeRangeParam() is the hook a
// page uses to keep that value in the URL as `?range=` or `?from=&to=`
// (history.replaceState through the router when there is one, so Back is not
// flooded), and to read it back on load and on popstate. A custom range is
// validated before it is sent: end after start, and not longer than
// `maxRangeDays`.

import { tk } from "../lib/i18n.js";
import {
  applyTimeRange,
  fromDatetimeLocal,
  isPresetRange,
  MAX_RANGE_DAYS,
  parseTimeRange,
  RANGE_IDS,
  rangeProblem,
  resolveTimeRange,
  toDatetimeLocal,
} from "../lib/time-range.js";
import { useFormat, useT } from "../ui/hooks.js";
import { useServices } from "../ui/context.js";
import { html } from "../ui/html.js";
import { useCallback, useEffect, useId, useState } from "../ui/vendor.js";
import { Button } from "./button.js";

function currentSearch(services) {
  try {
    return services?.router?.current?.search ?? globalThis.location?.search ?? "";
  } catch {
    return "";
  }
}

/**
 * The range kept in the URL.
 * @returns {[value, set(value), { valid, problem }]} `set` writes the URL without a history entry.
 */
export function useTimeRangeParam({ fallback = "24h", maxRangeDays = MAX_RANGE_DAYS } = {}) {
  const services = useServices();
  const read = () => parseTimeRange(currentSearch(services), { fallback, maxRangeDays });
  const [state, setState] = useState(read);
  useEffect(() => {
    const onPop = () => setState(read());
    globalThis.addEventListener?.("popstate", onPop);
    return () => globalThis.removeEventListener?.("popstate", onPop);
  }, [fallback, maxRangeDays]);
  const set = useCallback((value) => {
    setState({ value, valid: true, problem: null });
    try {
      const location = globalThis.location;
      const target = `${location.pathname}${applyTimeRange(location.search, value)}${location.hash}`;
      if (services.router?.navigate) services.router.navigate(target, { replace: true });
      else globalThis.history.replaceState(globalThis.history.state, "", target);
    } catch {
      // Without a history (tests, previews) the value stays in memory.
    }
  }, [services]);
  return [state.value, set, { valid: state.valid, problem: state.problem }];
}

/** The label of a value: "Last 24 h" for a preset, the formatted span for a custom range. */
export function useRangeLabel() {
  const { t } = useT();
  const fmt = useFormat();
  return (value, now = Date.now()) => {
    if (value && isPresetRange(value.range)) return t(tk("common.range.", value.range));
    const span = resolveTimeRange(value, now);
    return fmt.range(span.from, span.to);
  };
}

// value { range } | { from, to } (ms); compare: undefined hides the toggle, else true|false.
export function TimeRangePicker({ value, compare, onChange, maxRangeDays = MAX_RANGE_DAYS, now, testid }) {
  const { t } = useT();
  const label = useRangeLabel();
  const id = useId();
  const preset = value && isPresetRange(value.range);
  const [custom, setCustom] = useState(() => !preset);
  const [from, setFrom] = useState(() => (preset ? "" : toDatetimeLocal(value?.from)));
  const [to, setTo] = useState(() => (preset ? "" : toDatetimeLocal(value?.to)));
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    if (preset) {
      setCustom(false);
    } else {
      setFrom(toDatetimeLocal(value?.from));
      setTo(toDatetimeLocal(value?.to));
    }
  }, [preset, value?.range, value?.from, value?.to]);

  const emit = (next, extra = {}) => onChange?.(next, { compare, ...extra });

  function openCustom() {
    if (!custom && !from && !to) {
      const end = now ?? Date.now();
      setTo(toDatetimeLocal(end));
      setFrom(toDatetimeLocal(end - 60 * 60 * 1000));
    }
    setCustom(!custom);
  }

  function apply() {
    const next = { from: fromDatetimeLocal(from), to: fromDatetimeLocal(to) };
    const found = rangeProblem(next, { maxRangeDays });
    setProblem(found);
    if (!found) emit(next);
  }

  const fieldProblem = problem ? t(tk("common.range.problem.", problem), { days: maxRangeDays }) : null;
  return html`<div class="range-picker" role="group" aria-label=${t("common.range.label")} data-testid=${testid || "time-range-picker.root"}>
    <div class="row range-presets">
      ${RANGE_IDS.map((item) => html`<${Button} key=${item} size="sm" variant=${preset && value.range === item ? "primary" : "default"} aria-pressed=${preset && value.range === item ? "true" : "false"}
        onClick=${() => { setProblem(null); emit({ range: item }); }} testid=${`time-range-picker.${item}`}>${t(tk("common.range.", item))}<//>`)}
      <${Button} size="sm" variant=${!preset ? "primary" : "default"} aria-pressed=${!preset ? "true" : "false"} aria-expanded=${custom ? "true" : "false"} aria-controls=${`${id}-custom`}
        onClick=${openCustom} testid="time-range-picker.custom">${t("common.range.custom")}<//>
      ${compare === undefined ? null : html`<label class="row range-compare"><input type="checkbox" checked=${Boolean(compare)} data-testid="time-range-picker.compare"
        onChange=${(event) => emit(value, { compare: event.currentTarget.checked })} /> ${t("common.range.compare")}</label>`}
    </div>
    <p class="small muted range-current" role="status" data-window=${label(value, now)} data-testid="time-range-picker.label">${label(value, now)}</p>
    ${custom ? html`<div class="row range-custom" id=${`${id}-custom`} data-testid="time-range-picker.form">
      <div class="field">
        <label class="field-label" for=${`${id}-from`}>${t("common.range.from")}</label>
        <input class="input" id=${`${id}-from`} type="datetime-local" value=${from} aria-invalid=${problem ? "true" : undefined} aria-describedby=${problem ? `${id}-problem` : undefined}
          data-testid="time-range-picker.from" onInput=${(event) => setFrom(event.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="field-label" for=${`${id}-to`}>${t("common.range.to")}</label>
        <input class="input" id=${`${id}-to`} type="datetime-local" value=${to} aria-invalid=${problem ? "true" : undefined} aria-describedby=${problem ? `${id}-problem` : undefined}
          data-testid="time-range-picker.to" onInput=${(event) => setTo(event.currentTarget.value)} />
      </div>
      <${Button} size="sm" variant="primary" onClick=${apply} testid="time-range-picker.apply">${t("common.range.apply")}<//>
    </div>
    ${fieldProblem ? html`<p class="field-error small" id=${`${id}-problem`} role="alert" data-testid="time-range-picker.problem">${fieldProblem}</p>` : null}` : null}
  </div>`;
}
