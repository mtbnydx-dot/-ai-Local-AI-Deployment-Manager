// Fetchers the Access pages share, so one cache key always holds one shape.

import { customerRows } from "../../lib/access-model.js";

/** GET /api/billing/customers as `{ ok, rows }`; `ok` is false when billing cannot be read (the pages then degrade). */
export function fetchCustomers(api) {
  return api.get("/api/billing/customers", { query: { limit: 200 } }).then(
    (payload) => ({ ok: true, rows: customerRows(payload) }),
    (error) => ({ ok: false, rows: [], error }),
  );
}
