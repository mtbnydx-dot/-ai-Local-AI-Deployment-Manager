// The failure card of a dry probe (07 §6.3 step 2, 02 R-UI-6): the same
// RootCausePanel a failed launch gets. Loaded on demand by step-engine.js, which
// stays inside the route budget; a suggestion returns to Review.

import { runtimesHref } from "../../lib/launch-model.js";
import { RootCausePanel } from "../../components/root-cause-panel.js";
import { html } from "../../ui/html.js";
import { useFailureActions, useSignature } from "./failure-actions.js";

/** @param failure jobFailure(job)  @param wizard the step's props { draft, plan, catalog, update, launch, goto } */
export default function ProbeFailure({ failure, wizard }) {
  const signature = useSignature(failure, true);
  const actions = useFailureActions(wizard);
  return html`<${RootCausePanel} kind="probe" error=${failure} signature=${signature} catalog=${wizard.catalog} testid="wizard.probe.failure"
    onApply=${actions.applyParam} runtimeHref=${runtimesHref(wizard.draft.engineId)} />`;
}
