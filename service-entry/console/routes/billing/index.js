// /billing (07 §6.11, CON-27): the native billing center. Five tabs (overview,
// customers & credentials, plans & prices, usage & ledger, audit) over the
// /api/billing/* routes; each tab is its own module that loads on demand, and
// the routes billing.credentials / .plans / .ledger are deep links into a
// section of their tab. The page is for the owner on this machine (05 §5.4
// strictLocalBillingAdmin); anyone else sees the EmptyState. The classic page
// at /billing/classic remains as a fallback and is linked from the header.

import { Button } from "../../components/button.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { StatusBadge } from "../../components/status-badge.js";
import { Tabs } from "../../components/tabs.js";
import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { useRole, useT } from "../../ui/hooks.js";
import { useServices } from "../../ui/context.js";
import { html } from "../../ui/html.js";
import { useRoute, useRouter } from "../../ui/shell.js";
import { useBillingData } from "./data.js";
import { LazyView } from "./views.js";

export const TABS = Object.freeze(["overview", "customers", "prices", "usage", "audit"]);
const TAB_PATH = Object.freeze({ overview: "/billing", customers: "/billing/customers", prices: "/billing/prices", usage: "/billing/usage", audit: "/billing/audit" });
const ROUTE_TAB = Object.freeze({
  billing: "overview",
  "billing.customers": "customers",
  "billing.credentials": "customers",
  "billing.plans": "prices",
  "billing.prices": "prices",
  "billing.usage": "usage",
  "billing.ledger": "usage",
  "billing.audit": "audit",
});
const ROUTE_SECTION = Object.freeze({ "billing.credentials": "credentials", "billing.plans": "plans", "billing.ledger": "ledger" });
const HASH_SECTION = Object.freeze({ "#billing-adjustment": "adjustment" });
const LOAD = Object.freeze({
  overview: () => import("./overview.js"),
  customers: () => import("./customers.js"),
  prices: () => import("./prices.js"),
  usage: () => import("./usage.js"),
  audit: () => import("./audit.js"),
});
const API_TONE = Object.freeze({ loading: "loading", ok: "ok", partial: "warn", down: "error" });

/** The tab a billing route name belongs to (every billing route is one of the five). */
export function tabOf(routeName) {
  return ROUTE_TAB[routeName] || "overview";
}

/** The manager a legacy `?manager=vllm|llama` link names, as the billing manager id; the default for the manager selects. */
export function managerFromQuery(query) {
  const value = String(query?.manager || "").trim();
  return value === "llama" || value === "llama-manager" ? "llama-manager" : "vllm-manager";
}

function Notices({ data, t, i18n }) {
  const failures = data.errors;
  const limits = Object.entries(data.truncated).filter(([, value]) => value);
  return html`<div class="stack-sm" data-testid="billing.notices">
    ${data.state === "partial" || data.state === "down"
      ? html`<p class=${`notice ${data.state === "down" ? "notice-danger" : "notice-warn"}`} role="status" data-testid="billing.notice">${t(data.state === "down" ? "billing.notice.down" : "billing.notice.partial")}</p>`
      : null}
    ${failures.length
      ? html`<div class="notice notice-warn" data-testid="billing.errors"><details>
        <summary>${t("billing.errors.summary", { count: failures.length })}</summary>
        <ul>${failures.map(({ kind, error }) => html`<li key=${kind} data-user-content>${t(tk("billing.endpoint.", kind))}: ${describeError(error, i18n)}</li>`)}</ul>
      </details></div>`
      : null}
    ${limits.length
      ? html`<p class="notice" role="status" data-testid="billing.limits">${limits.map(([key, value]) => t("billing.limit", { label: t(tk("billing.endpoint.", key)), shown: value.shown, total: value.total })).join("; ")}</p>`
      : null}
  </div>`;
}

function BillingPage({ route, query }) {
  const i18n = useT();
  const { t } = i18n;
  const router = useRouter();
  const current = useRoute();
  const tab = tabOf(route?.name);
  const data = useBillingData({ tab });
  const section = ROUTE_SECTION[route?.name] || HASH_SECTION[current?.hash] || null;
  const tabs = TABS.map((id) => ({ id, label: t(tk("billing.tab.", id)) }));
  const stateLabel = t(tk("billing.api.", data.state));
  return html`<div class="stack" data-testid="billing.root">
    <${PageHeader} title=${t("shell.nav.billing")} subtitle=${t("billing.subtitle")}
      meta=${html`<${StatusBadge} status=${API_TONE[data.state]} label=${stateLabel} testid="billing.api-state" />`}
      actions=${html`<${Button} href="/billing/classic" testid="billing.classic">${t("billing.classic")}<//>
        <${Button} onClick=${data.refresh} busy=${data.busy} testid="billing.refresh">${t("billing.refresh")}<//>`} />
    <${Notices} data=${data} t=${t} i18n=${i18n} />
    <div data-testid="billing.workbench" aria-busy=${data.busy ? "true" : "false"}>
      <${Tabs} tabs=${tabs} value=${tab} urlParam=${null} label=${t("billing.tabs.label")} testid="billing.tabs"
        onChange=${(id) => router.navigate(TAB_PATH[id])}>
        <${LazyView} key=${tab} load=${LOAD[tab]} data=${data} section=${section} query=${query || {}} defaultManager=${managerFromQuery(query)} />
      <//>
    </div>
  </div>`;
}

export default function Billing({ route, query } = {}) {
  const { t } = useT();
  const services = useServices();
  const role = useRole();
  const local = services.bootstrap?.access?.local !== false;
  if (role !== "owner" || !local) {
    return html`<div class="stack" data-testid="billing.root">
      <${PageHeader} title=${t("shell.nav.billing")} />
      <${EmptyState} testid="billing.local-only" icon="lock" level=${2} title=${t("billing.localOnly.title")} body=${t("billing.localOnly.body")} action=${{ label: t("billing.localOnly.action"), href: "/overview" }} />
    </div>`;
  }
  return html`<${BillingPage} route=${route} query=${query} />`;
}
