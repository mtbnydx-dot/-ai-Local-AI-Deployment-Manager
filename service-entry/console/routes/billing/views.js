// Small views and formatters the billing tabs share (07 §6.11). Text from the
// API is always rendered as a text node (Preact escapes it), and `data-user-content`
// marks it for the shell's overflow rules.

import { Button } from "../../components/button.js";
import { EmptyState } from "../../components/empty-state.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { tk } from "../../lib/i18n.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { h, html } from "../../ui/html.js";
import { useEffect, useRef, useState } from "../../ui/vendor.js";
import {
  decimalIsZero,
  formatDecimal,
  formatInteger,
  formatSignedDecimal,
  integerFromApi,
  managerName,
  microcreditsToCredits,
} from "../../lib/billing-model.js";

/** Number and money formatting for the active locale; amounts stay exact strings. */
export function useBillingFormat() {
  const i18n = useT();
  const fmt = useFormat();
  const { t, locale } = i18n;
  const credits = (value) => `${formatDecimal(value || "0", locale)} ${t("billing.unit.credits")}`;
  return {
    t,
    locale,
    integer: (value) => formatInteger(value, locale),
    decimal: (value) => formatDecimal(value, locale),
    credits,
    microcredits: (value) => credits(microcreditsToCredits(value, "0", true)),
    signedCredits: (value) => `${formatSignedDecimal(value, locale)} ${t("billing.unit.credits")}`,
    rate: (micro) => t("billing.rate", { micro: formatInteger(micro, locale), credits: credits(microcreditsToCredits(micro, "0")) }),
    dateTime: (value) => (value ? fmt.dateTime(value) : "—"),
    quota: (value, kind) => {
      const raw = integerFromApi(value, "0");
      return BigInt(raw) === 0n ? t(tk("billing.unlimited.", kind)) : `${formatInteger(raw, locale)} ${t(tk("billing.unit.", kind))}`;
    },
    mode: (mode) => t(tk("billing.mode.", mode === "hard" ? "hard" : "shadow")),
    manager: (id) => managerName(id) || "—",
    zero: decimalIsZero,
  };
}

/** A cell with a main line and, under it, a smaller detail line. */
export function Cell({ primary, detail, code = false }) {
  return html`<span data-user-content>
    ${code ? html`<code class="code-inline">${primary}</code>` : primary}
    ${detail ? html`<span class="muted xsmall billing-detail">${detail}</span>` : null}
  </span>`;
}

const TONE = { ok: "ok", warn: "warn", fail: "error", "": "neutral" };

export function Tone({ tone, children, testid }) {
  return html`<${StatusBadge} status=${TONE[tone] || "neutral"} label=${children} testid=${testid} />`;
}

export function CustomerStatus({ status }) {
  const { t } = useT();
  const tone = status === "active" ? "ok" : status === "suspended" ? "warn" : "fail";
  return html`<${Tone} tone=${tone}>${t(tk("billing.customerStatus.", status))}<//>`;
}

export function ActiveStatus({ active, onKey = "billing.state.enabled" }) {
  const { t } = useT();
  return html`<${Tone} tone=${active ? "ok" : "warn"}>${t(active ? onKey : "billing.state.disabled")}<//>`;
}

export function UsageStatus({ usage, state }) {
  const { t } = useT();
  const label = t(tk("billing.usageState.", state.state));
  return html`<${Tone} tone=${state.tone}>${usage.httpStatus ? `${label} · ${usage.httpStatus}` : label}<//>`;
}

/** The empty state every billing table shows: it names what is missing and offers a refresh. */
export function EmptyTable({ data, titleKey, icon = "receipt", testid }) {
  const { t } = useT();
  return html`<${EmptyState} icon=${icon} level=${3} title=${t(titleKey)} body=${data.loaded ? undefined : t("billing.empty.notLoaded")}
    action=${{ label: t("billing.refresh"), onClick: data.refresh }} testid=${testid} />`;
}

/** A provider-style filter button group (aria-pressed toggles). */
export function Chip({ pressed, onClick, children, testid, ...rest }) {
  return html`<${Button} size="sm" variant=${pressed ? "primary" : "default"} aria-pressed=${pressed ? "true" : "false"} onClick=${onClick} testid=${testid} ...${rest}>${children}<//>`;
}

/** A page section with a stable id; it scrolls into view when it is the deep-link target (/billing/credentials …). */
export function Section({ id, active = false, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "start" });
  }, [active]);
  return html`<div id=${id} ref=${ref} class="billing-section">${children}</div>`;
}

/** Renders `module[name]` with `props` once `load()` has resolved (a route module keeps its own static imports small, 07 §11). */
export function LazyView({ load, name = "default", ...props }) {
  const { t } = useT();
  const [state, setState] = useState({ Component: null, failed: false });
  useEffect(() => {
    let alive = true;
    setState({ Component: null, failed: false });
    load().then(
      (module) => alive && setState({ Component: module[name] || null, failed: !module[name] }),
      () => alive && setState({ Component: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [name]);
  if (state.failed) return html`<p class="field-error" role="alert">${t("billing.lazy.failed")}</p>`;
  return state.Component ? h(state.Component, props) : html`<div aria-busy="true"><${Skeleton} shape="line" rows=${3} /></div>`;
}
