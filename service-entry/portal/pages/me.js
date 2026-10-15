// My Key (05 §12.5). Paste a key (kept in sessionStorage only, sent in the
// Authorization header only), then see what it may do, how much is left, how
// the usage looks and what the last requests were. Rotate shows the new key
// once; the allowed-origins editor checks the same rules the server enforces.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "../lib/html.js";
import { usePortal, usePageTitle } from "../lib/context.js";
import { useNow, useResource } from "../lib/hooks.js";
import { ApiError, fetchUsageCsv, getMe, getMeRequests, getMeUsage, rotateOwnKey, saveOwnOrigins } from "../lib/api.js";
import { formatCredits, formatDateTime, formatInteger, formatMilliseconds, formatPercent, modelPath } from "../lib/format.js";
import { MAX_ORIGINS, addOrigin, buildRequestChart, buildTokenChart, expiryView, formatClock, paceView, scopeKey } from "../lib/me-view.js";
import { DataTable } from "../components/table.js";
import { CopyButton } from "../components/copy-button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Gauge, PaceBar } from "../components/gauge.js";
import { StatusBadge } from "../components/status-badge.js";
import { UsageChart } from "../components/usage-chart.js";
import { EmptyState, ErrorNotice, Loading, errorMessage } from "../components/notice.js";

const LIVE_MS = 10_000;
const USAGE_MS = 60_000;
const REQUESTS_MS = 30_000;
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

const isRejected = (error) => error instanceof ApiError && [401, 403].includes(error.status) && error.code !== "scope_denied";

/** "3 d 4 h" / "5 h 10 min" / "12 min" (short units: no plural forms to get wrong). */
function spanText(t, span) {
  if (span.days > 0) return t("me.span.days_hours", { days: span.days, hours: span.hours });
  if (span.hours > 0) return t("me.span.hours_minutes", { hours: span.hours, minutes: span.minutes });
  return t("me.span.minutes", { minutes: span.minutes });
}

// ---- sign in ----------------------------------------------------------------------

function SignIn({ notice }) {
  const { t, setKey, toast } = usePortal();
  const [value, setValue] = useState("");
  const [state, setState] = useState({ busy: false, problem: "" });

  async function submit(event) {
    event.preventDefault();
    const text = value.trim().replace(/^Bearer\s+/i, "");
    if (!KEY_SHAPE.test(text)) {
      setState({ busy: false, problem: t("me.signin.shape") });
      return;
    }
    setState({ busy: true, problem: "" });
    try {
      await getMe(text);
    } catch (error) {
      setState({ busy: false, problem: isRejected(error) ? t("me.signin.rejected") : errorMessage(t, error) });
      return;
    }
    setValue("");
    setKey(text);
    toast(t("me.signin.done"));
  }

  return html`<section class="card me-signin" aria-labelledby="signin-title">
    <h2 id="signin-title" class="section-title">${t("me.signin.title")}</h2>
    <p class="card-text">${t("me.signin.text")}</p>
    ${notice ? html`<p class="notice notice-warn" role="status">${notice}</p>` : null}
    <form onSubmit=${submit} novalidate>
      <div class="field">
        <label for="me-key">${t("me.signin.label")}</label>
        <input id="me-key" name="key" type="password" value=${value} autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-…"
          aria-describedby="me-key-help" aria-invalid=${state.problem ? "true" : "false"} onInput=${(event) => setValue(event.currentTarget.value)} />
      </div>
      <p id="me-key-help" class="muted small">${t("me.signin.help")}</p>
      ${state.problem ? html`<p class="notice notice-error" role="alert">${state.problem}</p>` : null}
      <p class="card-actions"><button type="submit" class="btn btn-primary" disabled=${state.busy || !value.trim()}>${state.busy ? t("common.loading") : t("me.signin.submit")}</button></p>
    </form>
  </section>`;
}

// ---- sections ---------------------------------------------------------------------

function KeyHeader({ me, now, onSignOut }) {
  const { t, lang } = usePortal();
  const expiry = expiryView(me.expires_at, now);
  const status = me.status === "active" ? "operational" : "offline";
  return html`<section class="card me-head" aria-labelledby="me-head-title">
    <div class="card-head">
      <h2 id="me-head-title" class="card-title">${me.name || t("me.unnamed")}</h2>
      <${StatusBadge} kind=${status} label=${t.has(`me.status.${me.status}`) ? t(`me.status.${me.status}`) : String(me.status)} />
    </div>
    <dl class="facts facts-wide">
      <div class="fact"><dt>${t("me.preview")}</dt><dd><code>${me.preview}</code></dd></div>
      <div class="fact"><dt>${t("me.class")}</dt><dd>${t.has(`me.class.${me.class}`) ? t(`me.class.${me.class}`) : String(me.class)}</dd></div>
      <div class="fact"><dt>${t("me.created")}</dt><dd>${formatDateTime(me.created_at, lang) || t("common.not_set")}</dd></div>
      <div class="fact"><dt>${t("me.expires")}</dt><dd data-testid="me-expiry" data-urgent=${String(expiry.urgent)} class=${expiry.urgent ? "expiry-urgent" : ""}>
        ${expiry.state === "never" ? t("me.expiry.never") : null}
        ${expiry.state === "expired" ? html`<strong>${t("me.expiry.expired", { when: formatDateTime(me.expires_at, lang) })}</strong>` : null}
        ${expiry.state === "active" ? html`${formatDateTime(me.expires_at, lang)} · ${expiry.urgent ? html`<strong>${t("me.expiry.soon", { left: spanText(t, expiry) })}</strong>` : t("me.expiry.left", { left: spanText(t, expiry) })}` : null}
      </dd></div>
    </dl>
    <p class="card-actions"><button type="button" class="btn" onClick=${onSignOut}>${t("me.signout")}</button></p>
  </section>`;
}

function AccessSection({ me }) {
  const { t } = usePortal();
  const patterns = Array.isArray(me.models?.patterns) ? me.models.patterns : [];
  const available = Array.isArray(me.models?.available) ? me.models.available : [];
  return html`<section class="card" aria-labelledby="me-access-title">
    <h2 id="me-access-title" class="section-title">${t("me.access.title")}</h2>
    <h3>${t("me.access.scopes")}</h3>
    ${me.scopes?.length
      ? html`<ul class="chips me-scopes">${me.scopes.map((scope) => html`<li class="chip" data-scope=${scope}>${t.has(scopeKey(scope)) ? t(scopeKey(scope)) : scope}</li>`)}</ul>`
      : html`<p class="muted">${t("me.access.no_scopes")}</p>`}
    <h3>${t("me.access.models")}</h3>
    ${!patterns.length
      ? html`<p class="muted">${t("me.access.models_none")}</p>`
      : patterns.length === 1 && patterns[0] === "*"
        ? html`<p>${t("me.access.models_all")}</p>`
        : html`<ul class="chips">${patterns.map((pattern) => html`<li class="chip"><code>${pattern}</code></li>`)}</ul>`}
    <h3>${t("me.access.available")}</h3>
    ${available.length
      ? html`<ul class="chips me-available">${available.map((id) => html`<li class="chip chip-accent"><a href=${modelPath(id)}>${id}</a></li>`)}</ul>`
      : html`<p class="muted">${t("me.access.available_none")}</p>`}
  </section>`;
}

function LimitsSection({ me, loading, stale }) {
  const { t, lang } = usePortal();
  const rate = me.rate_limit || {};
  const requests = rate.requests;
  const tokens = rate.tokens;
  const concurrency = rate.concurrency;
  const maxConcurrent = me.limits?.max_concurrent;
  const reset = (item) => (item && Number.isFinite(item.reset_seconds) ? t("me.live.refills", { seconds: item.reset_seconds }) : "");
  const free = concurrency ? (Number.isFinite(concurrency.remaining) ? concurrency.remaining : Number(concurrency.limit) - Number(concurrency.in_flight || 0)) : null;
  return html`<section class="card" aria-labelledby="me-live-title" aria-busy=${String(loading)}>
    <h2 id="me-live-title" class="section-title">${t("me.live.title")}</h2>
    <p class="muted small">${stale ? t("me.live.stale") : t("me.live.note")}</p>
    <div class="gauge-row">
      ${requests
        ? html`<${Gauge} testid="gauge-rpm" label=${t("me.live.rpm")} value=${requests.remaining} max=${requests.limit}
          valueText=${formatInteger(requests.remaining, lang)} maxText=${formatInteger(requests.limit, lang)} caption=${reset(requests)} />`
        : null}
      ${tokens
        ? html`<${Gauge} testid="gauge-tpm" label=${t("me.live.tpm")} value=${tokens.remaining} max=${tokens.limit}
          valueText=${formatInteger(tokens.remaining, lang)} maxText=${formatInteger(tokens.limit, lang)} caption=${reset(tokens)} />`
        : html`<${Gauge} testid="gauge-tpm" label=${t("me.live.tpm")} value=${null} valueText=${t("me.live.no_limit")} caption=${t("me.live.no_token_cap")} />`}
      ${concurrency && free !== null
        ? html`<${Gauge} testid="gauge-concurrency" label=${t("me.live.concurrency")} value=${free} max=${Number(concurrency.limit)}
          valueText=${formatInteger(free, lang)} maxText=${formatInteger(concurrency.limit, lang)} caption=${t("me.live.free_slots")} />`
        : html`<${Gauge} testid="gauge-concurrency" label=${t("me.live.concurrency")} value=${null}
          valueText=${Number.isFinite(maxConcurrent) ? formatInteger(maxConcurrent, lang) : t("me.live.no_limit")} caption=${t("me.live.at_once")} />`}
    </div>
    <p class="muted small">${t("me.live.output_cap", { tokens: Number.isFinite(me.limits?.max_output_tokens) ? formatInteger(me.limits.max_output_tokens, lang) : t("me.live.no_limit") })}</p>
  </section>`;
}

function QuotaBar({ kind, quota, resetsAt, now, usage }) {
  const { t, lang } = usePortal();
  const view = paceView(quota, resetsAt, kind, now);
  if (!view) return null;
  const percent = formatPercent(view.usedFraction * 100, lang);
  const valueText = t("me.quota.value", { used: formatInteger(view.used, lang), limit: formatInteger(view.limit, lang), percent });
  const clock = (value) => formatClock(value, now, lang);
  let note;
  if (view.pace === "exhausted") note = t("me.quota.exhausted", { when: clock(view.resetsAt) });
  else if (view.pace === "ahead" && view.exhaustAt) note = t("me.quota.runs_out", { when: clock(view.exhaustAt) });
  else if (view.pace === "ahead") note = t("me.quota.ahead");
  else note = t("me.quota.on_pace");
  return html`<div class="quota-row" data-testid=${`quota-${kind}`}>
    <${PaceBar} label=${t(`me.quota.${kind}`)} used=${view.used} limit=${view.limit} usedFraction=${view.usedFraction} markerFraction=${view.elapsedFraction}
      pace=${view.pace} valueText=${valueText} markerLabel=${t("me.quota.marker")} />
    <p class=${`quota-note quota-${view.pace}`}><strong>${view.pace === "ok" ? "" : "▲ "}${note}</strong>${view.resetsAt ? html` <span class="muted">${t("me.quota.resets", { when: clock(view.resetsAt) })}</span>` : null}</p>
    ${usage ? html`<p class="muted small">${t("me.quota.usage", { requests: formatInteger(usage.requests, lang), input: formatInteger(usage.input_tokens, lang), cached: formatInteger(usage.cached_input_tokens, lang), output: formatInteger(usage.output_tokens, lang) })}</p>` : null}
  </div>`;
}

function QuotaSection({ me, now }) {
  const { t } = usePortal();
  const daily = me.quota?.daily_tokens;
  const monthly = me.quota?.monthly_tokens;
  return html`<section class="card" aria-labelledby="me-quota-title">
    <h2 id="me-quota-title" class="section-title">${t("me.quota.title")}</h2>
    ${!daily && !monthly ? html`<p class="muted">${t("me.quota.none")}</p>` : null}
    ${daily ? html`<${QuotaBar} kind="day" quota=${daily} resetsAt=${me.usage?.today?.resets_at} now=${now} usage=${me.usage?.today} />` : null}
    ${monthly ? html`<${QuotaBar} kind="month" quota=${monthly} resetsAt=${me.usage?.month?.resets_at} now=${now} usage=${me.usage?.month} />` : null}
  </section>`;
}

function BalanceSection({ billing }) {
  const { t } = usePortal();
  if (!billing || billing.bound === false) return null;
  const mode = String(billing.mode || "");
  return html`<section class="card" aria-labelledby="me-balance-title">
    <h2 id="me-balance-title" class="section-title">${t("me.balance.title")}</h2>
    <dl class="facts">
      <div class="fact"><dt>${t("me.balance.balance")}</dt><dd data-testid="balance">${formatCredits(billing.balance_credits) || t("common.no_data")}</dd></div>
      <div class="fact"><dt>${t("me.balance.spend")}</dt><dd>${formatCredits(billing.period_spend_credits) || t("common.no_data")}</dd></div>
      <div class="fact"><dt>${t("me.balance.mode")}</dt><dd data-mode=${mode}>${t.has(`me.balance.mode_${mode}`) ? t(`me.balance.mode_${mode}`) : mode}</dd></div>
    </dl>
    <p class="muted small">${t("me.balance.unit")}</p>
  </section>`;
}

function ChartsSection({ keyValue }) {
  const { t } = usePortal();
  const usage = useResource((signal) => getMeUsage(keyValue, { groupByModel: true }, { signal }), [keyValue], { intervalMs: USAGE_MS });
  const rows = usage.data && Array.isArray(usage.data.data) ? usage.data.data : null;
  const signature = rows ? JSON.stringify(rows) : "";
  const tokens = useMemo(() => (rows ? buildTokenChart(rows) : null), [signature]);
  const requests = useMemo(() => (rows ? buildRequestChart(rows) : null), [signature]);
  const telemetry = usage.data?.source === "telemetry";
  const labelTokens = (item) => (item.id === "total" ? t("me.chart.total_tokens") : item.id === "other" ? t("me.chart.other_models") : item.model);
  const labelRequests = (item) => (item.id === "errors" ? t("me.chart.errors") : t("me.chart.requests"));
  return html`<section class="card" aria-labelledby="me-charts-title">
    <h2 id="me-charts-title" class="section-title">${t("me.chart.title")}</h2>
    ${usage.loading && !rows ? html`<${Loading} />` : null}
    ${usage.error && !rows ? html`<${ErrorNotice} error=${usage.error} onRetry=${usage.reload} />` : null}
    ${tokens
      ? html`<div class="chart-grid">
        <${UsageChart} testid="chart-tokens" model=${tokens} title=${t("me.chart.tokens")} labelOf=${labelTokens}
          caption=${telemetry ? t("me.chart.by_model") : t("me.chart.totals_only")}
          emptyText=${telemetry ? t("me.chart.empty_telemetry") : t("me.chart.empty_counters")} />
        <${UsageChart} testid="chart-requests" model=${requests} title=${t("me.chart.requests_title")} labelOf=${labelRequests} errorIndex=${1}
          caption=${t("me.chart.errors_note")} emptyText=${telemetry ? t("me.chart.empty_telemetry") : t("me.chart.empty_counters")} />
      </div>`
      : null}
  </section>`;
}

function RequestsSection({ keyValue }) {
  const { t, lang } = usePortal();
  const list = useResource((signal) => getMeRequests(keyValue, 50, { signal }), [keyValue], { intervalMs: REQUESTS_MS });
  const rows = list.data && Array.isArray(list.data.data) ? list.data.data : null;
  const dash = "—";
  const num = (value) => (value === null || value === undefined ? dash : formatInteger(value, lang));
  return html`<section class="card" aria-labelledby="me-requests-title">
    <h2 id="me-requests-title" class="section-title">${t("me.requests.title")}</h2>
    <p class="muted small">${t("me.requests.note")}</p>
    ${list.loading && !rows ? html`<${Loading} />` : null}
    ${list.error && !rows ? html`<${ErrorNotice} error=${list.error} onRetry=${list.reload} />` : null}
    ${rows && !rows.length
      ? html`<${EmptyState} title=${t("me.requests.empty")}><p class="muted">${list.data.source === "counters" ? t("me.requests.empty_counters") : t("me.requests.empty_hint")}</p><//>`
      : null}
    ${rows && rows.length
      ? html`<div data-testid="requests-table"><${DataTable} caption=${t("me.requests.table")}
        head=${[t("me.requests.time"), t("me.requests.model"), t("me.requests.endpoint"), t("me.requests.tokens"), t("me.requests.ttft"), t("me.requests.duration"), t("me.requests.status"), t("me.requests.id")]}
        rows=${rows.map((row) => [
          formatDateTime(row.at, lang) || dash,
          html`<code>${row.model || dash}</code>`,
          html`<code>${row.endpoint || dash}</code>${row.stream ? html` <span class="chip">${t("me.requests.stream")}</span>` : null}`,
          `${num(row.input_tokens)} / ${num(row.cached_input_tokens)} / ${num(row.output_tokens)}`,
          (row.ttft_ms === null || row.ttft_ms === undefined ? null : formatMilliseconds(row.ttft_ms)) || dash,
          (row.duration_ms === null || row.duration_ms === undefined ? null : formatMilliseconds(row.duration_ms)) || dash,
          html`<span class=${Number(row.status) >= 400 ? "req-bad" : ""}>${row.status ?? dash}${row.error_code ? html` · <code>${row.error_code}</code>` : null}</span>`,
          html`<code class="req-id">${row.request_id}</code> <${CopyButton} text=${row.request_id} label=${`${t("copy.label")} ${row.request_id}`} />`,
        ])} /></div>`
      : null}
  </section>`;
}

// ---- actions ----------------------------------------------------------------------

function OriginsEditor({ me, keyValue, onSaved }) {
  const { t, toast } = usePortal();
  const saved = Array.isArray(me.allowed_origins) ? me.allowed_origins : [];
  const savedSignature = JSON.stringify(saved);
  const [list, setList] = useState(saved);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(list) !== savedSignature;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // The 10 s refresh brings the server's list; edits in progress are never overwritten.
  useEffect(() => {
    if (!dirtyRef.current) setList(saved);
  }, [savedSignature]);
  const editable = me.self_service?.origins === true;

  function add(event) {
    event.preventDefault();
    const result = addOrigin(list, draft);
    if (!result.ok) {
      setProblem(t(`me.origins.err_${result.reason}`, { max: MAX_ORIGINS }));
      return;
    }
    setProblem("");
    setList(result.list);
    setDraft("");
  }

  async function save() {
    setBusy(true);
    setProblem("");
    try {
      const answer = await saveOwnOrigins(keyValue, list);
      setList(Array.isArray(answer.allowed_origins) ? answer.allowed_origins : list);
      toast(t("me.origins.saved"));
      onSaved();
    } catch (error) {
      setProblem(errorMessage(t, error));
    } finally {
      setBusy(false);
    }
  }

  return html`<div class="origins" data-testid="origins-editor">
    <h3 id="origins-title">${t("me.origins.title")}</h3>
    <p class="muted small">${t("me.origins.text")}</p>
    ${editable ? null : html`<p class="notice notice-info" role="status">${t("me.origins.locked")}</p>`}
    ${list.length
      ? html`<ul class="origin-list" aria-labelledby="origins-title">${list.map((origin) => html`<li><code>${origin}</code>
        ${editable ? html`<button type="button" class="btn btn-small" aria-label=${t("me.origins.remove_label", { origin })} onClick=${() => { setList(list.filter((item) => item !== origin)); setProblem(""); }}>${t("me.origins.remove")}</button>` : null}</li>`)}</ul>`
      : html`<p class="muted">${t("me.origins.empty")}</p>`}
    ${editable
      ? html`<form class="toolbar" onSubmit=${add} novalidate>
        <div class="field">
          <label for="origin-input">${t("me.origins.label")}</label>
          <input id="origin-input" type="text" inputmode="url" value=${draft} placeholder="https://app.example.com" autocomplete="off" spellcheck="false"
            aria-invalid=${problem ? "true" : "false"} aria-describedby="origin-problem" onInput=${(event) => setDraft(event.currentTarget.value)} />
        </div>
        <button type="submit" class="btn">${t("me.origins.add")}</button>
        <button type="button" class="btn btn-primary" disabled=${!dirty || busy} onClick=${save}>${busy ? t("common.loading") : t("me.origins.save")}</button>
      </form>`
      : null}
    <p id="origin-problem" class=${problem ? "notice notice-error" : "visually-hidden"} role="alert">${problem}</p>
  </div>`;
}

function Actions({ me, keyValue, reload }) {
  const { t, setKey, toast } = usePortal();
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState("");
  const [fresh, setFresh] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const canRotate = me.self_service?.rotate === true;

  async function rotate() {
    setRotating(true);
    setRotateError("");
    try {
      const answer = await rotateOwnKey(keyValue);
      if (typeof answer?.key !== "string" || !answer.key) throw new ApiError("No key in the answer", { code: "invalid_response" });
      // The new secret exists only in this answer: it replaces the session key and is shown once.
      setKey(answer.key);
      setFresh({ key: answer.key, preview: answer.preview || "" });
      setConfirming(false);
    } catch (error) {
      setRotateError(error?.code === "rate_limit_exceeded" ? t("me.rotate.limited") : errorMessage(t, error));
    } finally {
      setRotating(false);
    }
  }

  async function download() {
    setDownloading(true);
    try {
      const { blob, filename } = await fetchUsageCsv(keyValue);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.className = "visually-hidden";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      toast(errorMessage(t, error), "error");
    } finally {
      setDownloading(false);
    }
  }

  return html`<section class="card" aria-labelledby="me-actions-title">
    <h2 id="me-actions-title" class="section-title">${t("me.actions.title")}</h2>
    ${fresh
      ? html`<div class="notice notice-warn fresh-key" role="alert" data-testid="fresh-key">
        <p class="notice-title">${t("me.rotate.done_title")}</p>
        <p>${t("me.rotate.done_text")}</p>
        <p><code class="secret" data-testid="fresh-key-value">${fresh.key}</code></p>
        <p class="card-actions"><${CopyButton} text=${fresh.key} label=${t("me.rotate.copy_label")} />
          <button type="button" class="btn btn-primary" onClick=${() => setFresh(null)}>${t("me.rotate.saved")}</button></p>
      </div>`
      : null}
    <div class="action-row">
      <div>
        <h3>${t("me.rotate.title")}</h3>
        <p class="muted small">${t("me.rotate.text")}</p>
        ${canRotate ? null : html`<p class="notice notice-info" role="status">${t("me.rotate.locked")}</p>`}
        <button type="button" class="btn" disabled=${!canRotate || rotating} onClick=${() => { setRotateError(""); setConfirming(true); }}>${t("me.rotate.button")}</button>
      </div>
      <div>
        <h3>${t("me.csv.title")}</h3>
        <p class="muted small">${t("me.csv.text")}</p>
        <button type="button" class="btn" disabled=${downloading} onClick=${download}>${downloading ? t("common.loading") : t("me.csv.button")}</button>
      </div>
    </div>
    <${OriginsEditor} me=${me} keyValue=${keyValue} onSaved=${reload} />
    <${ConfirmDialog} open=${confirming} title=${t("me.rotate.confirm_title")} confirmLabel=${t("me.rotate.confirm")} cancelLabel=${t("me.rotate.cancel")}
      busy=${rotating} onConfirm=${rotate} onCancel=${() => setConfirming(false)} testid="rotate-dialog">
      <p>${t("me.rotate.confirm_text")}</p>
      ${rotateError ? html`<p class="notice notice-error" role="alert">${rotateError}</p>` : null}
    <//>
  </section>`;
}

// ---- page -------------------------------------------------------------------------

function Dashboard({ keyValue, onRejected }) {
  const { t, setKey } = usePortal();
  const me = useResource((signal) => getMe(keyValue, { signal }), [keyValue], { intervalMs: LIVE_MS });
  const now = useNow(15_000);
  const doc = me.data;
  const rejectedFirst = !doc && isRejected(me.error);
  // A stored key the server does not accept is dropped, so the sign-in form returns with a note.
  useEffect(() => {
    if (rejectedFirst) onRejected();
  }, [rejectedFirst]);

  if (!doc && me.error) return rejectedFirst ? html`<${Loading} />` : html`<${ErrorNotice} error=${me.error} onRetry=${me.reload} />`;
  if (!doc) return html`<${Loading} />`;
  const signOut = () => setKey("");
  return html`<div class="me-dashboard stack">
    ${me.error ? html`<p class="notice notice-warn" role="status">${isRejected(me.error) ? t("me.signin.stored_rejected") : t("me.refresh_failed")}</p>` : null}
    <${KeyHeader} me=${doc} now=${now} onSignOut=${signOut} />
    <${AccessSection} me=${doc} />
    <${LimitsSection} me=${doc} loading=${me.loading} stale=${Boolean(me.error)} />
    <${QuotaSection} me=${doc} now=${now} />
    <${BalanceSection} billing=${doc.billing} />
    <${ChartsSection} keyValue=${keyValue} />
    <${RequestsSection} keyValue=${keyValue} />
    <${Actions} me=${doc} keyValue=${keyValue} reload=${me.reload} />
  </div>`;
}

export default function MePage() {
  const { t, key, setKey } = usePortal();
  const [notice, setNotice] = useState("");
  usePageTitle(t("nav.me"));
  return html`<div class="page page-me">
    <h1>${t("me.title")}</h1>
    <p class="lead">${t("me.lead")}</p>
    ${key ? html`<${Dashboard} keyValue=${key} onRejected=${() => { setNotice(t("me.signin.stored_rejected")); setKey(""); }} />` : html`<${SignIn} notice=${notice} />`}
  </div>`;
}
