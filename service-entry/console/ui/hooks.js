// Preact hooks over the console services (07 §3.5).
//
// useQuery reads through the query cache: one fetch per key however many
// components ask, refetch when an event invalidates the key, and per-key
// timers (`refetchMs`) only for keys no event covers or while both SSE and
// /api/events/recent fail. Polling pauses while the tab is hidden. Mutations
// invalidate the prefixes they declare; nothing is rewritten optimistically.

import { describeError } from "../lib/api.js";
import { EVENTED_PREFIXES } from "../lib/events.js";
import { stableKey } from "../lib/store.js";
import { useServices } from "./context.js";
import { useCallback, useEffect, useRef, useState } from "./vendor.js";

function isEvented(key) {
  return EVENTED_PREFIXES.some((prefix) => prefix.every((part, index) => key[index] === part));
}

function hidden(services) {
  try {
    return Boolean(services.visibility?.hidden?.());
  } catch {
    return false;
  }
}

/**
 * @returns {{ data, error, status, updatedAt, fetching, refetch() }}
 */
export function useQuery(key, fn, { ttlMs = 5000, refetchMs = 0, enabled = true, keepPrevious = true } = {}) {
  const services = useServices();
  const { cache } = services;
  const id = stableKey(key);
  const keyRef = useRef(key);
  keyRef.current = key;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [view, setView] = useState(() => cache.get(key));
  const previous = useRef(undefined);

  const run = useCallback((force) => cache.fetch(keyRef.current, () => fnRef.current(), { ttlMs, force }).catch(() => undefined), [id, ttlMs]);

  useEffect(() => {
    if (!enabled) return undefined;
    setView(cache.get(keyRef.current));
    const off = cache.subscribe(keyRef.current, (next) => {
      setView(next);
      if (next.invalidated && !next.fetching) run(false);
    });
    run(false);
    let timer = null;
    if (refetchMs > 0) {
      const evented = isEvented(keyRef.current);
      timer = globalThis.setInterval(() => {
        if (hidden(services)) return;
        if (!evented || services.events?.needsTimers?.()) run(true);
      }, refetchMs);
    }
    return () => {
      off();
      if (timer !== null) globalThis.clearInterval(timer);
    };
  }, [id, enabled, ttlMs, refetchMs]);

  if (view.data !== undefined) previous.current = view.data;
  const data = view.data !== undefined || !keepPrevious ? view.data : previous.current;
  return {
    data,
    error: view.error,
    status: view.status,
    updatedAt: view.updatedAt,
    fetching: view.fetching,
    refetch: () => run(true),
  };
}

/**
 * @param fn the mutation, (...args) → Promise
 * @param options.invalidates key prefixes to invalidate after success
 * @param options.toast { success?: catalog key, error?: true } — an error toast uses the error's catalog text
 * @returns {{ run(...args) → Promise, status: "idle"|"pending"|"success"|"error", error }}
 */
export function useMutation(fn, { invalidates = [], toast = {} } = {}) {
  const services = useServices();
  const [state, setState] = useState({ status: "idle", error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (...args) => {
    setState({ status: "pending", error: null });
    try {
      const result = await fnRef.current(...args);
      for (const prefix of invalidates) services.cache.invalidate(prefix);
      setState({ status: "success", error: null });
      if (toast.success) services.toasts?.push?.({ tone: "success", text: services.i18n.t(toast.success) });
      return result;
    } catch (error) {
      setState({ status: "error", error });
      if (toast.error) services.toasts?.push?.({ tone: "error", text: describeError(error, services.i18n), requestId: error?.requestId || null });
      throw error;
    }
  }, [stableKey(invalidates), toast.success, toast.error]);

  return { run, status: state.status, error: state.error };
}

/** Calls `handler(envelope)` for every event of `type` while mounted. */
export function useEvent(type, handler) {
  const { events } = useServices();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!events?.on) return undefined;
    return events.on(type, (envelope) => ref.current(envelope));
  }, [events, type]);
}

/** `[value, set(value) → boolean]` for one preference (lib/prefs.js). */
export function usePref(name) {
  const { prefs } = useServices();
  const [value, setValue] = useState(() => prefs?.get?.(name));
  useEffect(() => {
    if (!prefs?.subscribe) return undefined;
    setValue(prefs.get(name));
    return prefs.subscribe((all) => setValue(all[name]));
  }, [prefs, name]);
  const set = useCallback((next) => Boolean(prefs?.set?.(name, next)), [prefs, name]);
  return [value, set];
}

/** The i18n service: { t, has, pick, tk, locale }. */
export function useT() {
  return useServices().i18n;
}

/** "owner" | "viewer" | "none", updated when a 401 or 403 refreshes the role. */
export function useRole() {
  const { role } = useServices();
  const [value, setValue] = useState(() => role?.get?.() ?? "viewer");
  useEffect(() => {
    if (!role?.subscribe) return undefined;
    setValue(role.get());
    return role.subscribe(setValue);
  }, [role]);
  return value;
}

/** Whether a CSS media query matches, e.g. "(max-width: 767px)". */
export function useMediaQuery(query) {
  const read = () => {
    try {
      return Boolean(globalThis.matchMedia?.(query)?.matches);
    } catch {
      return false;
    }
  };
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    let list;
    try {
      list = globalThis.matchMedia?.(query);
    } catch {
      list = null;
    }
    if (!list) return undefined;
    const onChange = () => setMatches(Boolean(list.matches));
    onChange();
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/** `value`, updated only after it stopped changing for `ms`. */
export function useDebounced(value, ms = 300) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setCurrent(value), ms);
    return () => globalThis.clearTimeout(timer);
  }, [value, ms]);
  return current;
}

/** The formatters for the active locale (lib/format.js). */
export function useFormat() {
  return useServices().formatters;
}
