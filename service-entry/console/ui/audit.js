// The audit unlock as a hook (07 §6.8). One session per tab lives in the
// services (lib/audit-session.js); this hook re-renders a page when it is
// unlocked, locked or runs out, so a Lock in one place closes the content
// everywhere. Pages and the request detail read the request headers from it:
// empty in cookie mode (05's HttpOnly cookie rides on its own) and
// `x-audit-session` only in the degrade mode.

import { createAuditSession } from "../lib/audit-session.js";
import { useServices } from "./context.js";
import { useEffect, useState } from "./vendor.js";

let standalone = null;

/** The tab's audit session; a bare one when the services carry none (tests, previews). */
export function useAuditSession() {
  const { audit } = useServices();
  const session = audit || (standalone ||= createAuditSession());
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((tick) => tick + 1);
    const off = session.subscribe?.(bump);
    // The unlock ends at its expiry even when nothing else happens on the page.
    let timer = null;
    const until = Date.parse(session.expiresAt?.() || "");
    if (Number.isFinite(until)) timer = globalThis.setTimeout(() => {
      session.active();
      bump();
    }, Math.min(Math.max(until - Date.now(), 0) + 50, 2 ** 31 - 1));
    return () => {
      off?.();
      if (timer !== null) globalThis.clearTimeout(timer);
    };
  }, [session, session.mode?.()]);
  return session;
}
