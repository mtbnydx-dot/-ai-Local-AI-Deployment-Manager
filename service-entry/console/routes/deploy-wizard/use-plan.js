// usePlan (07 §6.3 "Plan loop"): keeps the launch plan of the draft current.
// lib/wizard-state.js createPlanLoop does the work (250 ms debounce, dedupe by
// requestKey, abort of the previous request, the last plan kept on a failure);
// this hook only feeds it the draft's request and renders its state.
//
//   const plan = usePlan(draft, { card, catalog, enabled });
//   plan.status  idle | updating | ready | error
//   plan.plan    the last LaunchPlan (an ok:false plan is a plan, HTTP 200, 00 §9.2)
//   plan.error   a 400 or a transport failure; the page shows a banner and keeps `plan.plan`
//   plan.refresh() sends the same request again now

import { LaunchPlanGuard } from "../../lib/schemas.js";
import { createPlanLoop, planReady, planRequest, requestKey } from "../../lib/wizard-state.js";
import { useServices } from "../../ui/context.js";
import { useEffect, useMemo, useRef, useState } from "../../ui/vendor.js";

const IDLE = Object.freeze({ status: "idle", plan: null, planKey: null, error: null, requests: 0 });

export function usePlan(draft, { card, catalog, enabled = true } = {}) {
  const { api } = useServices();
  const apiRef = useRef(api);
  apiRef.current = api;
  const [state, setState] = useState(IDLE);
  const loop = useRef(null);
  if (!loop.current) {
    loop.current = createPlanLoop({
      send: (managerId, body, { signal }) => apiRef.current.manager(managerId).post("/launch/plan", body, { signal, guard: LaunchPlanGuard }),
      onChange: setState,
    });
  }
  const remote = draft.modelRef?.kind === "remote";
  const body = useMemo(
    () => (enabled && planReady(draft) && (!remote || card) ? planRequest(draft, { card, catalog }) : null),
    [draft, card, catalog, enabled, remote],
  );
  const key = body ? requestKey(body) : "";
  const managerId = draft.managerId;
  useEffect(() => {
    if (body) loop.current.request(managerId, body);
    else loop.current.pause();
  }, [key, managerId]);
  useEffect(() => () => loop.current.dispose(), []);
  return {
    ...state,
    body,
    refresh: () => {
      if (body) loop.current.refresh(managerId, body);
    },
  };
}
