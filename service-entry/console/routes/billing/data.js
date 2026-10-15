// What the billing page reads (07 §6.11, CON-27): every /api/billing/* list
// through the query cache, rebuilt by model.js from an allowlist, plus the
// state of the whole read (healthy, partly failing, down). One cache key per
// resource under ["billing", …], so a write invalidates ["billing"] and every
// table refetches. The page fetches everything once, as the classic page did;
// only the template catalog waits for the prices tab.

import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "../../ui/vendor.js";
import {
  createTextNormalizers,
  normalizeCredential,
  normalizeCustomer,
  normalizeList,
  normalizePlan,
  normalizePrice,
  normalizeSummary,
  normalizeUsage,
  normalizeUsageSummary,
} from "../../lib/billing-model.js";

export const PAGE = 100;
const TTL = 10_000;

/** Minutes east of UTC of this browser, which the server uses to cut months and days. */
export function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/** One page of GET /api/billing/usage; `cursor` is the keyset cursor of the previous page. */
export function fetchUsage(api, { customerId = "", cursor = "", tz = tzOffsetMinutes() } = {}) {
  return api.get("/api/billing/usage", { query: { window: "month", limit: PAGE, tzOffsetMinutes: tz, ...(customerId ? { customerId } : {}), ...(cursor ? { cursor } : {}) } });
}

/** Rows loaded beyond a first page; reset whenever the first page is refetched. */
export function usePaged({ first, fetchPage, resetKey }) {
  const [extra, setExtra] = useState({ items: [], next: null, loading: false });
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  useEffect(() => {
    setExtra({ items: [], next: null, loading: false });
  }, [first.updatedAt, resetKey]);
  const next = extra.items.length || extra.next ? extra.next : first.next;
  const loadMore = useCallback(async (after) => {
    setExtra((current) => ({ ...current, loading: true }));
    try {
      const page = await fetchPage(after);
      if (alive.current) setExtra((current) => ({ items: [...current.items, ...page.items], next: page.next, loading: false }));
    } catch {
      if (alive.current) setExtra((current) => ({ ...current, loading: false }));
    }
  }, [fetchPage]);
  return { rows: [...first.items, ...extra.items], cursor: next, loading: extra.loading, loadMore };
}

function usageNext(payload) {
  return typeof payload?.nextCursor === "string" && payload.nextCursor ? payload.nextCursor : null;
}

/** First page and "next offset" of an offset-paged list answer. */
function offsetPage(list, offset) {
  return { items: list.items, next: list.count >= PAGE ? String(offset + list.count) : null };
}

export function useBillingData({ tab }) {
  const { api } = useServices();
  const i18n = useT();
  const tz = useMemo(() => tzOffsetMinutes(), []);
  const get = (path, query) => () => api.get(path, query ? { query } : {});

  const status = useQuery(["billing", "clients"], get("/api/status"), { ttlMs: TTL });
  const overview = useQuery(["billing", "overview"], get("/api/billing/overview"), { ttlMs: TTL });
  const customers = useQuery(["billing", "customers"], get("/api/billing/customers", { limit: 200 }), { ttlMs: TTL });
  const plans = useQuery(["billing", "plans"], get("/api/billing/plans", { limit: 100 }), { ttlMs: TTL });
  const prices = useQuery(["billing", "prices"], get("/api/billing/prices", { limit: 200 }), { ttlMs: TTL });
  const credentials = useQuery(["billing", "credentials"], get("/api/billing/credentials", { limit: 200 }), { ttlMs: TTL });
  const usage = useQuery(["billing", "usage", ""], () => fetchUsage(api, { tz }), { ttlMs: TTL });
  const summary = useQuery(["billing", "summary", "customer,model,month", tz], get("/api/billing/usage/summary", { groupBy: "customer,model,month", tzOffsetMinutes: tz }), { ttlMs: TTL });
  const daily = useQuery(["billing", "summary", "day", tz], get("/api/billing/usage/summary", { groupBy: "day", tzOffsetMinutes: tz }), { ttlMs: TTL });
  const ledger = useQuery(["billing", "ledger"], get("/api/billing/ledger", { limit: PAGE }), { ttlMs: TTL });
  const audit = useQuery(["billing", "audit"], get("/api/billing/audit-events", { limit: PAGE }), { ttlMs: TTL });
  const templates = useQuery(["billing", "templates"], get("/api/billing/templates"), { ttlMs: 60_000, enabled: tab === "prices" });

  const queries = { status, overview, customers, plans, prices, credentials, usage, usageSummary: summary, usageDaily: daily, ledger, auditEvents: audit, ...(tab === "prices" ? { templates } : {}) };
  const redacted = i18n.t("billing.redacted");
  const text = useMemo(() => createTextNormalizers(redacted), [redacted]);

  const model = useMemo(() => {
    const customerList = normalizeList(customers.data, "customers", normalizeCustomer);
    const planList = normalizeList(plans.data, "plans", normalizePlan);
    const priceList = normalizeList(prices.data, "prices", normalizePrice);
    const credentialList = normalizeList(credentials.data, "credentials", normalizeCredential);
    const usageList = normalizeList(usage.data, "usage", normalizeUsage);
    const ledgerList = normalizeList(ledger.data, "ledger", text.ledger);
    const auditList = normalizeList(audit.data, "auditEvents", text.audit);
    const templateList = normalizeList(templates.data, "items", text.template);
    return {
      summary: normalizeSummary(overview.data?.overview || overview.data?.summary || overview.data?.data || overview.data),
      customers: customerList.items,
      plans: planList.items,
      prices: priceList.items,
      credentials: credentialList.items,
      usage: { items: usageList.items, next: usageNext(usage.data) },
      usageSummary: normalizeUsageSummary(summary.data),
      usageDaily: normalizeUsageSummary(daily.data),
      ledger: { ...offsetPage(ledgerList, 0), updatedAt: ledger.updatedAt },
      audit: { ...offsetPage(auditList, 0), updatedAt: audit.updatedAt },
      templates: templateList.items,
      templateMeta: {
        catalogVersion: String(templates.data?.catalogVersion || "").slice(0, 100),
        source: String(templates.data?.source || templates.data?.sourceLabel || "").slice(0, 120),
        snapshot: String(templates.data?.snapshotDate || templates.data?.snapshot || templates.data?.updatedAt || "").slice(0, 80),
      },
      managers: Array.isArray(status.data?.managers) ? status.data.managers : [],
      truncated: {
        customers: customerList.truncated ? { shown: customerList.items.length, total: customerList.total } : null,
        plans: planList.truncated ? { shown: planList.items.length, total: planList.total } : null,
        prices: priceList.truncated ? { shown: priceList.items.length, total: priceList.total } : null,
        credentials: credentialList.truncated ? { shown: credentialList.items.length, total: credentialList.total } : null,
      },
    };
  }, [overview.data, customers.data, plans.data, prices.data, credentials.data, usage.data, summary.data, daily.data, ledger.data, ledger.updatedAt, audit.data, audit.updatedAt, templates.data, status.data, text]);

  const entries = Object.entries(queries);
  const failed = entries.filter(([, query]) => query.status === "error" && query.data === undefined);
  const succeeded = entries.filter(([kind, query]) => kind !== "status" && query.data !== undefined).length;
  const settled = entries.every(([, query]) => query.status !== "loading" && query.status !== "idle");
  const fetching = entries.some(([, query]) => query.fetching);
  const state = !settled && succeeded === 0 ? "loading" : succeeded === 0 ? "down" : failed.length ? "partial" : "ok";

  const customerNames = useMemo(() => new Map(model.customers.map((item) => [item.id, item.name])), [model.customers]);
  const planNames = useMemo(() => new Map(model.plans.map((item) => [item.id, item.name])), [model.plans]);
  const refresh = () => Promise.all(entries.map(([, query]) => query.refetch()));

  return {
    ...model,
    state,
    loaded: succeeded > 0,
    settled,
    busy: fetching,
    errors: failed.map(([kind, query]) => ({ kind, error: query.error })),
    customerName: (id) => (id ? customerNames.get(id) || id : ""),
    planName: (id) => (id ? planNames.get(id) || id : ""),
    refresh,
    refetchTemplates: templates.refetch,
    /** Raw requests of one customer (or all), a keyset page after `after`. */
    pageUsage: async (after, customerId = "") => {
      const payload = await fetchUsage(api, { cursor: after, customerId, tz });
      return { items: normalizeList(payload, "usage", normalizeUsage).items, next: usageNext(payload) };
    },
    pageLedger: async (offset) => offsetPage(normalizeList(await api.get("/api/billing/ledger", { query: { limit: PAGE, offset: Number(offset) || 0 } }), "ledger", text.ledger), Number(offset) || 0),
    pageAudit: async (offset) => offsetPage(normalizeList(await api.get("/api/billing/audit-events", { query: { limit: PAGE, offset: Number(offset) || 0 } }), "auditEvents", text.audit), Number(offset) || 0),
    tz,
  };
}
