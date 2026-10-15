// The ModelCard of the draft's model (07 §6.3 step 1): POST /api/models/inspect
// {path} or {source, repo, revision} (02 caches the result), then GET
// /api/models/:id/card?view=full. A 404 card_not_found (the cache was
// cleared) runs inspect again.

import { guards } from "./guards.js";
import { inspectRequest } from "../../lib/wizard-state.js";
import { useServices } from "../../ui/context.js";
import { useQuery } from "../../ui/hooks.js";

const enc = encodeURIComponent;

export function modelKey(modelRef) {
  if (!modelRef) return "";
  return modelRef.kind === "remote" ? `remote:${modelRef.source}:${modelRef.repo}@${modelRef.revision}` : `local:${modelRef.path}`;
}

/** The full card for a model reference; rejects with the ApiError of the failing call. */
export async function loadCard(api, modelRef) {
  if (modelRef.cardId) {
    try {
      const body = await api.get(`/api/models/${enc(modelRef.cardId)}/card`, { query: { view: "full" }, guard: guards.card });
      return body.card;
    } catch (error) {
      if (error?.code !== "card_not_found" && error?.status !== 404) throw error;
    }
  }
  const body = await api.post("/api/models/inspect", inspectRequest(modelRef), { guard: guards.card });
  return body.card;
}

/** @returns {{ card, loading, error, refetch }}; `card` is null until the first answer for this very model (never the previous model's card). */
export function useCard(modelRef, { enabled = true } = {}) {
  const { api } = useServices();
  const key = modelKey(modelRef);
  const query = useQuery(["models", "card", key], async () => ({ key, card: await loadCard(api, modelRef) }), { ttlMs: 60000, enabled: enabled && Boolean(modelRef), keepPrevious: false });
  const active = enabled && Boolean(modelRef);
  // useQuery shows the previous key's view for one render after the key changes; the key stored with the answer tells them apart.
  const current = query.data?.key === key ? query.data.card : undefined;
  return {
    card: active ? current ?? null : null,
    loading: active && !query.error && current === undefined,
    error: active ? query.error ?? null : null,
    refetch: query.refetch,
  };
}

/** The query key of one compatibility request (shared by the GPU fit badges of step 1 and the matrix of step 2). */
export function compatKey(cardId, gpuIds = []) {
  return ["models", "compat", cardId, [...gpuIds].map(String).sort().join(",") || "all"];
}

/** GET /api/models/:id/compatibility for the GPUs (all when none) → { host, rows }. */
export async function loadCompatibility(api, cardId, gpuIds = []) {
  const gpus = [...gpuIds].map(String).join(",");
  return api.get(`/api/models/${enc(cardId)}/compatibility`, { query: gpus ? { gpus } : undefined, guard: guards.compatibility });
}
