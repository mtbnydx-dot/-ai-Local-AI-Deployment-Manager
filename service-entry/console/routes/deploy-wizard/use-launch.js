// useLaunch (07 §6.3 steps 6 and 7): the launch the wizard started.
//
//   const launch = useLaunch({ draft, plan, catalog, card, storage, goto });
//   launch.state.status   idle | starting | started
//   launch.start()        POST /api/m/:id/start with launchRequest(draft, plan) (it carries
//                         expectedPlanHash); an accepted launch moves to step 7, a 409
//                         `plan_changed` stays on Review with the new plan and what changed
//   launch.state.change   what Review should show before the next launch: the diff of a changed
//                         plan, or of a suggestion that was applied (nothing relaunches by itself)
//   launch.report(state)  step 7 tells the hook how the job ended; a ready job settles the draft
//
// The started launch is kept in sessionStorage (`console.wizard.launch`, ids only), so a reload
// of step 7 finds its job again.

import { describeError } from "../../lib/api.js";
import { launchRequest } from "../../lib/wizard-state.js";
import { LAUNCH_STORAGE_KEY, parseLaunch, planChangeRows, planChangedOf, pullStepOf, serializeLaunch, startOutcome } from "../../lib/launch-model.js";
import { useServices } from "../../ui/context.js";
import { useCallback, useRef, useState } from "../../ui/vendor.js";

const IDLE = Object.freeze({ status: "idle", error: null, change: null, jobState: null, settled: false });

function fromStored(stored) {
  return stored ? { ...IDLE, status: "started", jobState: "running", ...stored } : IDLE;
}

export function useLaunch({ draft, plan, catalog, card, storage, goto }) {
  const { api, i18n } = useServices();
  const [state, setState] = useState(() => fromStored(parseLaunch(storage?.sessionGet?.(LAUNCH_STORAGE_KEY), draft.id)));
  const latest = useRef({});
  latest.current = { draft, plan, catalog, card, goto, locale: i18n.locale };

  const start = useCallback(async () => {
    const { draft: current, plan: loop, catalog: engineCatalog, card: modelCard, goto: go, locale } = latest.current;
    const reviewed = loop.plan;
    setState((was) => ({ ...was, status: "starting", error: null, change: null }));
    try {
      const body = await api.manager(current.managerId).post("/start", launchRequest(current, reviewed, { card: modelCard, catalog: engineCatalog }));
      const outcome = startOutcome(body, reviewed?.planHash);
      if (!outcome.jobId) throw Object.assign(new Error("The manager accepted the launch but returned no job."), { code: "start_no_job" });
      const started = {
        draftId: current.id, managerId: current.managerId, jobId: outcome.jobId, launchId: outcome.launchId,
        instanceId: outcome.instanceId || current.instance.instanceId || current.instance.targetInstanceId,
        planHash: outcome.planHash, changedAtLaunch: outcome.changedAtLaunch, overrides: outcome.overrides,
        pull: (() => {
          const step = pullStepOf(reviewed);
          return step ? { required: step.required !== false, policy: step.policy, image: step.image } : null;
        })(),
      };
      storage?.sessionSet?.(LAUNCH_STORAGE_KEY, serializeLaunch(started));
      setState({ ...IDLE, status: "started", jobState: "running", ...started });
      go("launch");
    } catch (error) {
      const changed = planChangedOf(error);
      if (changed) {
        setState({ ...IDLE, change: { kind: "planChanged", rows: planChangeRows(reviewed, changed, engineCatalog, locale) } });
        loop.refresh?.();
        go("review");
        return;
      }
      setState({ ...IDLE, error });
    }
  }, [api]);

  // Back to a clean Review: forget the job (it keeps running on the manager), optionally with a change to show.
  const reset = useCallback((change = null) => {
    storage?.sessionRemove?.(LAUNCH_STORAGE_KEY);
    setState({ ...IDLE, change });
  }, [storage]);

  const report = useCallback((jobState) => {
    setState((was) => {
      if (was.status !== "started" || was.jobState === jobState) return was;
      return { ...was, jobState, settled: jobState === "success" };
    });
    if (jobState === "success") storage?.sessionRemove?.(LAUNCH_STORAGE_KEY);
  }, [storage]);

  const dismissChange = useCallback(() => setState((was) => (was.change ? { ...was, change: null } : was)), []);
  const message = state.error ? describeError(state.error, i18n) : "";
  return { state, message, start, reset, report, dismissChange };
}
