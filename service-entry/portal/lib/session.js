// The key session (05 §12.5). A pasted API key lives in sessionStorage only
// (try/catch: storage can be missing), is sent in an Authorization header
// only, and never appears in a URL. A share link carries it as #key=… ; it is
// read once and the fragment is removed at once.

import { SESSION_KEY, readStorage, writeStorage } from "./storage.js";

const KEY_FRAGMENT = /^#key=([^&\s]{1,512})$/;

/** The key a share-link fragment carries, or "" for any other hash. */
export function keyFromHash(hash) {
  const match = KEY_FRAGMENT.exec(String(hash || ""));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

export function readKey() {
  return readStorage("session", SESSION_KEY) || "";
}

export function storeKey(key) {
  return writeStorage("session", SESSION_KEY, key || null);
}

/**
 * Takes the key out of location.hash (stores it, strips the fragment through
 * history.replaceState) and returns it; "" when there was none.
 */
export function captureKeyFromLocation(location, history) {
  const key = keyFromHash(location.hash);
  if (!key) return "";
  storeKey(key);
  try {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  } catch {
    // The fragment stays visible only if the browser refuses replaceState.
  }
  return key;
}

/** "sk-abcd…wxyz": enough to recognise a key, never enough to use it. */
export function previewKey(key) {
  const text = String(key || "");
  if (text.length <= 10) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 5)}…${text.slice(-4)}`;
}
