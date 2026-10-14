// Boot step 1: pairing through a `#pair=<code>` link (07 §3.2, 05 §5.2).
//
// The fragment is removed from the address bar with history.replaceState
// synchronously, before any request or other boot code runs, so the code
// never lands in history, logs, the store or an error report. The code is
// sent once, in the POST /api/session/pair body.

const PAIR_PREFIX = "#pair=";
const CODE_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

/** The pairing code in `location.hash`, or null. Only well-formed codes are returned. */
export function extractPairCode(location) {
  const hash = String(location?.hash || "");
  if (!hash.startsWith(PAIR_PREFIX)) return null;
  let code = hash.slice(PAIR_PREFIX.length).split(/[&?#]/)[0];
  try {
    code = decodeURIComponent(code);
  } catch {
    return null;
  }
  return CODE_PATTERN.test(code) ? code : null;
}

/** Replaces the current entry with the same URL minus its fragment. Returns true when it ran. */
export function stripPairFragment({ history, location }) {
  if (!String(location?.hash || "").startsWith(PAIR_PREFIX)) return false;
  const target = `${location.pathname || "/"}${location.search || ""}`;
  try {
    history.replaceState(history.state ?? null, "", target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs boot step 1.
 * @param pair (code) → Promise<{ ok, csrfToken }>, normally api.post("/api/session/pair", { code })
 * @param reloadBootstrap () → Promise<bootstrap>, normally api.get("/api/console/bootstrap")
 * @returns {Promise<{ status: "none"|"paired"|"invalid"|"failed", bootstrap?, csrfToken?, screen? }>}
 *   `screen` is the PairingScreen state when pairing did not succeed.
 */
export async function runBootPair({ location, history, pair, reloadBootstrap }) {
  const hadFragment = String(location?.hash || "").startsWith(PAIR_PREFIX);
  const code = extractPairCode(location);
  // First, before anything awaits: the code must leave the address bar now.
  stripPairFragment({ history, location });
  if (!hadFragment) return { status: "none" };
  if (!code) return { status: "invalid", screen: { reason: "invalid" } };
  let answer;
  try {
    answer = await pair(code);
  } catch (error) {
    const invalid = error?.code === "pair_code_invalid" || error?.status === 400;
    // Never pass the caught error on: only its code, which carries no pairing code.
    return invalid
      ? { status: "invalid", screen: { reason: "invalid" } }
      : { status: "failed", errorCode: typeof error?.code === "string" ? error.code : "pair_failed", screen: { reason: "unpaired" } };
  }
  if (!answer || answer.ok !== true) return { status: "invalid", screen: { reason: "invalid" } };
  let bootstrap = null;
  try {
    bootstrap = await reloadBootstrap();
  } catch {
    bootstrap = null;
  }
  return { status: "paired", csrfToken: typeof answer.csrfToken === "string" ? answer.csrfToken : null, bootstrap };
}

/**
 * The PairingScreen props (07 §4.4) for a role and session: `none` shows it
 * at once; a viewer sees it on owner-only routes and after a 401.
 */
export function pairingScreenState({ reason = "unpaired", session = null } = {}) {
  return {
    reason: ["unpaired", "invalid", "expired"].includes(reason) ? reason : "unpaired",
    autoPairAvailable: session?.autoPairAvailable === true,
    pairCommand: typeof session?.pairCommand === "string" && session.pairCommand ? session.pairCommand : "platform admin pair",
  };
}
