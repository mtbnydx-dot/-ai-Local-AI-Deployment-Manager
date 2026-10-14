// Hooks for the shell's own state (07 §4.4 AppShell): the current route, the
// event-stream connection, the pairing overlay and the update flag. Each is a
// lib/store.js signal that app.js puts in the services bag; pages normally
// need only useRoute() and useBootstrap().

import { useServices } from "./context.js";
import { useEffect, useState } from "./vendor.js";

/** The value of a signal ({ get, subscribe }), re-rendering when it changes; `fallback` when there is none. */
export function useSignal(signal, fallback = null) {
  const [value, setValue] = useState(() => (signal?.get ? signal.get() : fallback));
  useEffect(() => {
    if (!signal?.subscribe) return undefined;
    setValue(signal.get());
    return signal.subscribe(setValue);
  }, [signal]);
  return value;
}

/** `{ route, params, pathname, search, hash, query }` of the page on screen, or null before the router starts. */
export function useRoute() {
  return useSignal(useServices().route);
}

/** `{ state: "connecting"|"open"|"polling"|"offline", lastOkAt }` of the entry event stream. */
export function useConnection() {
  return useSignal(useServices().connection, { state: "connecting", lastOkAt: null });
}

/** The §2.5 bootstrap the page was served with (role updates come from useRole()). */
export function useBootstrap() {
  return useServices().bootstrap || {};
}

/** True when the bootstrap reports the backend component `name` (07 §2.5 features). */
export function useFeature(name) {
  return Boolean(useBootstrap().features?.[name]);
}

/** The router: { navigate(to, { replace }), href(name, params, query), current }. */
export function useRouter() {
  return useServices().router;
}
