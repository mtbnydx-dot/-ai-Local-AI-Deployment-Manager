// Audit unlock state (07 §6.8).
//
// With 05's elevation cookie the login answer is { ok, expiresAt } and the
// console keeps only expiresAt; the HttpOnly cookie rides on /api/audit/*.
// On the degrade path (an answer that still carries `token`) the token is
// kept in this closure only, never in storage, and sent as x-audit-session.
// Either way the unlock ends at expiresAt, on lock() or when the tab closes.

const HEADER = "x-audit-session";

/**
 * @returns {{ unlock(answer), lock(), active(), expiresAt(), mode(), headers() }}
 */
export function createAuditSession({ now = Date.now } = {}) {
  let token = null;
  let expiresAt = null;

  function expired() {
    return expiresAt === null || now() >= expiresAt;
  }

  function clear() {
    token = null;
    expiresAt = null;
  }

  return {
    /** Takes the POST /api/audit/login answer; returns true when it unlocked. */
    unlock(answer) {
      clear();
      if (!answer || answer.ok !== true) return false;
      const until = Date.parse(answer.expiresAt);
      if (Number.isNaN(until) || until <= now()) return false;
      expiresAt = until;
      if (typeof answer.token === "string" && answer.token) token = answer.token;
      return true;
    },
    lock() {
      clear();
    },
    active() {
      if (expired()) {
        clear();
        return false;
      }
      return true;
    },
    /** The expiry as ISO text, or null when locked. */
    expiresAt() {
      return this.active() ? new Date(expiresAt).toISOString() : null;
    },
    /** "cookie" (05 elevation), "token" (degrade path) or "locked". */
    mode() {
      if (!this.active()) return "locked";
      return token ? "token" : "cookie";
    },
    /** Request headers for /api/audit/* and telemetry request detail; empty in cookie mode. */
    headers() {
      return this.active() && token ? { [HEADER]: token } : {};
    },
    toJSON() {
      return { mode: this.mode(), expiresAt: this.expiresAt() };
    },
  };
}
