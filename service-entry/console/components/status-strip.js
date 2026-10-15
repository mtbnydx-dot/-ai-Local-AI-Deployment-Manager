// StatusStrip (07 §4.4): the five 06 readiness layers as chip buttons in the
// topbar, then a GPU chip from `telemetry.live` and a version chip. Each chip
// opens a popover with the layer's detail and its action; the overall chip
// (the one left on a phone) lists every layer. Readiness comes from 06's
// PlatformStatus when the entry serves it, and from lib/readiness.js
// (/api/status plus /api/fleet) before that; both give the same model.
//
// Every state pairs an icon with text, never color alone. Layer text lives in
// the `platform` catalog area (platform.layer.*, platform.state.*,
// platform.serving.none, platform.action.*).

import { tk } from "../lib/i18n.js";
import { LAYER_IDS, readinessFrom } from "../lib/readiness.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useId, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

const LAYER_TONE = Object.freeze({ ok: "ok", warn: "warn", fail: "error", unknown: "neutral" });
const OVERALL_TONE = Object.freeze({ ok: "ok", degraded: "warn", down: "error", loading: "neutral" });
const TONE_ICON = Object.freeze({ ok: "circle-check", warn: "triangle-alert", error: "circle-x", neutral: "circle-help" });
const STATUS_WORDS = new Set(["ok", "warn", "fail", "unknown"]);
const MODES = new Set(["local", "lan", "public"]);
const KNOWN_STATES = new Set(["ready", "starting", "unhealthy", "stopped", "failed", "backoff", "blocked", "not-installed", "external", "unknown", "disabled"]);
// A layer code that has its own sentence; any other code reads platform.code.<code>.
const CODE_KEYS = Object.freeze({ no_model_serving: "platform.serving.none" });
const MAX_LISTED = 6;

/** `restore-models` → `platform.action.restoreModels`. */
export function actionKey(id) {
  return tk("platform.action.", String(id || "").replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase()));
}

function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

function layerValue(layer, servingCount) {
  if (layer.id === "serving") return { kind: "count", n: servingCount };
  if (layer.id === "exposure") return { kind: "mode", mode: MODES.has(layer.mode) ? layer.mode : "local" };
  const ready = finite(layer.counts?.ready);
  const total = finite(layer.counts?.total);
  if (layer.id === "components" && ready !== null && total !== null) return { kind: "ratio", ready, total };
  return { kind: "status" };
}

/** Mean utilisation and summed memory over the GPUs of a `telemetry.live` payload, or null. */
export function gpuSummary(live) {
  const gpus = (Array.isArray(live?.gpus) ? live.gpus : []).filter((gpu) => finite(gpu?.memTotalMb) !== null);
  if (!gpus.length) return null;
  const utils = gpus.map((gpu) => finite(gpu.util)).filter((value) => value !== null);
  return {
    util: utils.length ? utils.reduce((sum, value) => sum + value, 0) / utils.length : null,
    usedMb: gpus.reduce((sum, gpu) => sum + (finite(gpu.memUsedMb) ?? 0), 0),
    totalMb: gpus.reduce((sum, gpu) => sum + gpu.memTotalMb, 0),
    gpus: gpus.map((gpu, index) => ({ index: finite(gpu.index) ?? index, util: finite(gpu.util), usedMb: finite(gpu.memUsedMb) ?? 0, totalMb: gpu.memTotalMb })),
  };
}

/**
 * The model the strip renders.
 * @param loading true until the first status answer: the overall chip is neutral, not red
 * @returns {{ overall, tone, source, layers: Array<{ id, status, tone, value, code, detail, counts, mode, action }>, problems: Array<{ id, state }>, gpu, version }}
 */
export function buildStripModel({ platform = null, status = null, fleet = null, live = null, build = null, newerCommits = 0, loading = false } = {}) {
  const readiness = readinessFrom({ platform, status, fleet });
  const byId = new Map(readiness.layers.map((layer) => [layer.id, layer]));
  const servingCount = finite(platform?.models?.serving)
    ?? finite(readiness.serving)
    ?? finite(byId.get("serving")?.counts?.ready)
    ?? 0;
  const layers = LAYER_IDS.map((id) => {
    const layer = byId.get(id) || { id, status: "unknown" };
    const known = STATUS_WORDS.has(layer.status) ? layer.status : "unknown";
    return {
      id,
      status: known,
      tone: LAYER_TONE[known],
      value: layerValue(layer, servingCount),
      code: layer.code || null,
      detail: typeof layer.detail === "string" && layer.detail ? layer.detail : null,
      counts: layer.counts || null,
      mode: layer.mode || null,
      action: layer.action && typeof layer.action.id === "string" ? layer.action : null,
    };
  });
  const showLoading = loading && !platform && !status;
  const overall = showLoading ? "loading" : readiness.overall;
  const problems = readiness.source === "platform"
    ? (Array.isArray(platform?.components) ? platform.components : [])
      .filter((item) => item && typeof item.id === "string" && !["ready", "external", "disabled"].includes(item.state))
      .map((item) => ({ id: item.id, state: item.state }))
    : (byId.get("components")?.offline || []).map((id) => ({ id, state: "stopped" }));
  const commit = typeof build?.commit === "string" && build.commit ? build.commit.slice(0, 7) : null;
  // deploy writes "0.2.0-git-<sha>"; the chip shows the release, the popover the commit.
  const release = typeof build?.version === "string" ? build.version.replace(/-git-[0-9a-f]+$/i, "") : "";
  const label = release ? `v${release}` : commit;
  return {
    overall,
    tone: OVERALL_TONE[overall] || "neutral",
    source: readiness.source,
    layers,
    problems,
    gpu: gpuSummary(live),
    version: label ? { label, commit, newer: Number(newerCommits) > 0, newerCommits: Number(newerCommits) || 0 } : null,
  };
}

/** The sentence under a layer chip: its own code text first, then the server's detail, else null. */
export function layerDetail(layer, i18n) {
  const own = layer.code ? CODE_KEYS[layer.code] : null;
  if (own && i18n.has(own)) return i18n.t(own);
  const coded = layer.code ? tk("platform.code.", layer.code) : null;
  if (coded && i18n.has(coded)) return i18n.t(coded);
  return layer.detail;
}

// Esc and a press outside close a popover; Esc returns focus to its trigger.
function useDismiss(open, wrap, trigger, close) {
  useEffect(() => {
    if (!open) return undefined;
    const doc = globalThis.document;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.current?.focus();
    };
    const onPress = (event) => {
      if (!wrap.current?.contains(event.target)) close();
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onPress, true);
    return () => {
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointerdown", onPress, true);
    };
  }, [open]);
}

function Chip({ tone, icon, label, value, status, dot = false, align = "start", className = "", testid, children }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const id = useId();
  useDismiss(open, wrap, trigger, () => setOpen(false));
  return html`<span class=${`popover-wrap strip-chip ${className}`} ref=${wrap}>
    <button type="button" ref=${trigger} class=${`chip chip-${tone}`} aria-expanded=${open ? "true" : "false"} aria-controls=${open ? id : undefined}
      onClick=${() => setOpen(!open)} data-tone=${tone} data-testid=${testid}>
      <${Icon} name=${icon} /><span class="chip-label">${label}</span>
      ${value ? html`<span class="chip-value tabular">${value}</span>` : null}
      ${dot ? html`<span class="chip-dot" aria-hidden="true"></span>` : null}
      ${status ? html`<span class="sr-only">${status}</span>` : null}
    </button>
    ${open ? html`<div id=${id} class=${`popover strip-popover strip-${align}`} role="group" aria-label=${label} data-testid=${`${testid}.panel`}>${children}</div>` : null}
  </span>`;
}

function LayerPanel({ layer, problems, canAct, onAction }) {
  const i18n = useT();
  const { t, has, pick } = i18n;
  const detail = layerDetail(layer, i18n);
  const listed = layer.id === "components" ? problems.slice(0, MAX_LISTED) : [];
  const action = canAct && layer.action ? layer.action : null;
  const label = action ? (has(actionKey(action.id)) ? t(actionKey(action.id)) : pick(action.label) || action.id) : "";
  return html`<div class="stack-sm" data-layer=${layer.id}>
    <p><strong>${t(tk("platform.layer.", layer.id))}</strong> <span class="muted">${t(tk("platform.strip.status.", layer.status))}</span></p>
    ${detail ? html`<p data-testid="status-strip.detail">${detail}</p>` : null}
    ${layer.counts && layer.id !== "serving" ? html`<p class="small muted">${t("platform.strip.counts", { ready: layer.counts.ready ?? 0, total: layer.counts.total ?? 0 })}</p>` : null}
    ${listed.length ? html`<ul class="strip-list small">${listed.map((item) => html`<li key=${item.id}><code class="code-inline">${item.id}</code> ${t(tk("platform.state.", KNOWN_STATES.has(item.state) ? item.state : "unknown"))}</li>`)}</ul>` : null}
    ${action ? html`<${Button} size="sm" variant="primary" onClick=${() => onAction?.(action, layer)} testid=${`status-strip.action.${action.id}`}>${label}<//>` : null}
  </div>`;
}

function valueText(layer, i18n, fmt) {
  const { t } = i18n;
  switch (layer.value.kind) {
    case "count": return fmt.integer(layer.value.n);
    case "ratio": return `${fmt.integer(layer.value.ready)}/${fmt.integer(layer.value.total)}`;
    case "mode": return t(tk("platform.mode.", layer.value.mode));
    default: return "";
  }
}

// platform/status/fleet/live are query results (or null); build is { version, commit }; canAct hides actions from viewers.
export function StatusStrip({ platform = null, status = null, fleet = null, live = null, build = null, newerCommits = 0, loading = false, canAct = true, onAction, testid }) {
  const i18n = useT();
  const fmt = useFormat();
  const { t } = i18n;
  const model = buildStripModel({ platform, status, fleet, live, build, newerCommits, loading });
  const overallLabel = t(tk("platform.strip.overall.", model.overall));
  return html`<div class="strip" role="group" aria-label=${t("platform.strip.label")} data-overall=${model.overall} data-source=${model.source} data-testid=${testid || "status-strip.root"}>
    <${Chip} tone=${model.tone} icon=${model.overall === "loading" ? "loader-circle" : TONE_ICON[model.tone]} label=${overallLabel} testid="status-strip.overall" className="strip-overall">
      <div class="stack-sm">
        ${model.layers.map((layer) => html`<${LayerPanel} key=${layer.id} layer=${layer} problems=${model.problems} canAct=${canAct} onAction=${onAction} />`)}
        ${canAct ? html`<p class="small"><a href="/setup" data-testid="status-strip.setup">${t("platform.setup.reenter")}</a></p>` : null}
      </div>
    <//>
    ${model.layers.map((layer) => html`<${Chip} key=${layer.id} tone=${layer.tone} icon=${TONE_ICON[layer.tone]} label=${t(tk("platform.layer.", layer.id))}
      value=${valueText(layer, i18n, fmt)} status=${t(tk("platform.strip.status.", layer.status))} className="hide-sm" testid=${`status-strip.layer.${layer.id}`}>
      <${LayerPanel} layer=${layer} problems=${model.problems} canAct=${canAct} onAction=${onAction} />
    <//>`)}
    ${model.gpu ? html`<${Chip} tone="neutral" icon="activity" label=${t("platform.strip.gpu")} align="end" className="hide-md"
      value=${model.gpu.util === null ? t("platform.strip.gpuMem", { used: fmt.number(model.gpu.usedMb / 1024, 1), total: fmt.number(model.gpu.totalMb / 1024, 1) })
        : t("platform.strip.gpuValue", { util: fmt.integer(Math.round(model.gpu.util)), used: fmt.number(model.gpu.usedMb / 1024, 1), total: fmt.number(model.gpu.totalMb / 1024, 1) })}
      testid="status-strip.gpu">
      <ul class="strip-list small">${model.gpu.gpus.map((gpu) => html`<li key=${gpu.index}>${t("platform.strip.gpuLine", {
        index: gpu.index, util: gpu.util === null ? "—" : fmt.integer(Math.round(gpu.util)), used: fmt.number(gpu.usedMb / 1024, 1), total: fmt.number(gpu.totalMb / 1024, 1),
      })}</li>`)}</ul>
    <//>` : null}
    ${model.version ? html`<${Chip} tone=${model.version.newer ? "warn" : "neutral"} icon="info" label=${t("platform.strip.version")} value=${model.version.label} dot=${model.version.newer} align="end" className="hide-md"
      status=${model.version.newer ? t("platform.strip.newer", { n: model.version.newerCommits }) : ""} testid="status-strip.version">
      <div class="stack-sm">
        <p>${t("platform.strip.versionLine", { version: model.version.label })}</p>
        ${model.version.newer ? html`<p class="notice notice-warn" data-testid="status-strip.newer">${t("platform.strip.newer", { n: model.version.newerCommits })}</p>` : null}
        <a href="/system/updates">${t("platform.strip.updates")}</a>
      </div>
    <//>` : null}
  </div>`;
}
