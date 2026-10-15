// Response guards of the wizard's own calls (lib/guards.js). The shared
// schemas live in lib/schemas.js; these cover the 02/03 answers only this page reads.

import { CompatRowGuard } from "../../lib/schemas.js";
import { any, arr, bool, nullable, obj, opt, record, str } from "../../lib/guards.js";

const maybe = (guard) => opt(nullable(guard));

export const guards = Object.freeze({
  /** POST /api/models/inspect and GET /api/models/:id/card (02 §17). */
  card: obj({ ok: opt(bool), card: obj({ cardId: str }) }),
  /** GET /api/models/:id/compatibility (02 §9). */
  compatibility: obj({ ok: opt(bool), cardId: opt(str), host: maybe(record(any)), rows: arr(CompatRowGuard) }),
  /** POST /api/models/:id/probe: 202 { ok, jobId, managerId }. */
  probe: obj({ ok: opt(bool), jobId: str, managerId: opt(str) }),
});
