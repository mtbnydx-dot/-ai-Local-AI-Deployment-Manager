// What a failed job (launch or dry probe) lets the person do (07 §6.3 step 7,
// 02 R-UI-6): look up the error signature behind the failure, and apply a
// suggestion. Every suggestion changes the draft and returns to Review with the
// change as a DiffTable; nothing relaunches by itself.

import { describeError } from "../../lib/api.js";
import { signatureMap, suggestionRows } from "../../lib/launch-model.js";
import { missingEndpoint, recommendBody } from "../../lib/resources-model.js";
import { applySuggestion, stepOfField } from "../../lib/wizard-state.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { guards } from "./guards.js";

const SIGNATURE_TTL_MS = 600000;

function plain(entry) {
  return entry !== null && typeof entry === "object" && Object.hasOwn(entry, "value") ? entry.value : entry;
}

/** The signature entry of `failure.signatureId` (GET /api/knowledge?kind=error-signatures, fetched once per session). */
export function useSignature(failure, enabled) {
  const { api } = useServices();
  const signatures = useQuery(["knowledge", "error-signatures"], () => api.get("/api/knowledge", { query: { kind: "error-signatures" } }), { ttlMs: SIGNATURE_TTL_MS, enabled: Boolean(enabled && failure?.signatureId) });
  const map = useMemo(() => signatureMap(signatures.data), [signatures.data]);
  return failure?.signatureId ? map.get(failure.signatureId) || null : null;
}

/**
 * @returns {{ applyParam(suggestion), applyKnob(knob), notice }}; `launch.reset(change)` forgets the failed job
 * and hands Review the DiffTable rows of what the suggestion changed.
 */
export function useFailureActions({ draft, plan, catalog, update, launch, goto }) {
  const { api, toasts, i18n } = useServices();
  const { t, locale } = useT();
  const [notice, setNotice] = useState("");

  function backToReview(param, value, source = "user") {
    const rows = suggestionRows(draft, plan.plan, { param, value }, catalog, locale);
    update((now) => (source === "planner" ? { ...now, values: { ...now.values, [param]: { value, source } } } : applySuggestion(now, { param, value })));
    launch.reset({ kind: "suggestion", rows });
    goto("review");
  }

  // "to: planner" asks the planner for a concrete value for the current launch.
  async function plannerValue(param) {
    const cardId = draft.modelRef?.cardId;
    if (!cardId) return undefined;
    try {
      const body = await api.post("/api/launch/recommend", recommendBody(cardId, "balanced", draft.gpus), { guard: guards.recommend });
      const plans = body.gpuSets?.[0]?.plans || [];
      const match = plans.find((item) => item.engineId === draft.engineId) || plans[0];
      return plain(match?.values?.[param]);
    } catch (error) {
      if (!missingEndpoint(error)) setNotice(describeError(error, i18n));
      return undefined;
    }
  }

  async function applyParam(suggestion) {
    if (suggestion.to === "planner") {
      const value = await plannerValue(suggestion.param);
      if (value === undefined || value === null) {
        // No concrete value: send the person to the step that holds the setting.
        launch.reset(null);
        toasts?.push?.({ level: "info", title: t("models.wizard.launch.noPlannerValue") });
        goto(stepOfField(suggestion.param, catalog));
        return;
      }
      backToReview(suggestion.param, value, "planner");
      return;
    }
    backToReview(suggestion.param, suggestion.to);
  }

  return { applyParam, applyKnob: (knob) => backToReview(knob.param, knob.suggestion), notice };
}
