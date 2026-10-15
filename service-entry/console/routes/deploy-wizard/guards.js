// Response guards of the wizard's own calls (lib/guards.js). The shared
// schemas live in lib/schemas.js; these cover the 02/03 answers only this page reads.

import { CompatRowGuard } from "../../lib/schemas.js";
import { any, arr, bool, nullable, num, obj, opt, record, str } from "../../lib/guards.js";

const maybe = (guard) => opt(nullable(guard));

export const guards = Object.freeze({
  /** POST /api/models/inspect and GET /api/models/:id/card (02 §17). */
  card: obj({ ok: opt(bool), card: obj({ cardId: str }) }),
  /** GET /api/models/:id/compatibility (02 §9). */
  compatibility: obj({ ok: opt(bool), cardId: opt(str), host: maybe(record(any)), rows: arr(CompatRowGuard) }),
  /** POST /api/models/:id/probe: 202 { ok, jobId, managerId }. */
  probe: obj({ ok: opt(bool), jobId: str, managerId: opt(str) }),
  /** POST /api/launch/recommend (02 §11, §17): plans per GPU set; a plan without an engine or values is dropped. */
  recommend: obj({
    ok: opt(bool),
    cardId: opt(str),
    goal: opt(str),
    gpuSets: arr(obj({ gpuIds: arr(str), plans: arr(obj({ engineId: str, values: maybe(record(any)) })), notes: maybe(arr(any)) })),
    notes: opt(arr(any)),
  }),
  /** POST /api/models/:id/fit-grid (02 §10.8): KV dtype x concurrency cells with the largest context that fits. */
  fitGrid: obj({
    ok: opt(bool),
    engineId: opt(str),
    native: maybe(num),
    cells: arr(obj({ kvDtype: str, concurrency: num, maxContext: maybe(num), limitedBy: maybe(str), status: maybe(str), spill: maybe(bool), truncated: maybe(bool) })),
  }),
});
