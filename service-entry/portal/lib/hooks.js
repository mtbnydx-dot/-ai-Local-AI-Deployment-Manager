// Data loading for pages: one resource, an optional refresh interval that
// pauses while the tab is hidden, and the previous data kept on screen while a
// refresh runs or fails.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/**
 * useResource(load, deps, { intervalMs, enabled }) -> { data, error, loading, updatedAt, reload }
 *   load(signal) -> Promise<data>
 */
export function useResource(load, deps = [], { intervalMs = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled, updatedAt: 0 });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false, updatedAt: 0 });
      return undefined;
    }
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: previous.data === null }));
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false, updatedAt: Date.now() });
      },
      (error) => {
        if (controller.signal.aborted || error?.name === "AbortError") return;
        setState((previous) => ({ ...previous, error, loading: false }));
      },
    );
    return () => controller.abort();
  }, [...deps, tick, enabled]);

  useEffect(() => {
    if (!enabled || !intervalMs) return undefined;
    const bump = () => {
      if (document.visibilityState === "visible") setTick((value) => value + 1);
    };
    const timer = setInterval(bump, intervalMs);
    document.addEventListener("visibilitychange", bump);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", bump);
    };
  }, [intervalMs, enabled]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}

/** A clock that re-renders every `ms` (relative times). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
