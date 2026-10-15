// The effective values of Review (07 §6.3 step 6): a read-only SchemaForm over
// the plan, so every value shows where it comes from (you, the recipe, the
// model, the planner, a default) and why. Loaded on demand by step-review.js:
// the form is the heaviest part of the step.

import { SchemaForm } from "../../components/schema-form.js";
import { Skeleton } from "../../components/skeleton.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

export default function ReviewValues({ catalog, plan, draft }) {
  const [level, setLevel] = useState("advanced");
  if (!catalog) return html`<div aria-busy="true" data-testid="wizard.review.catalog-loading"><${Skeleton} shape="line" rows=${4} /></div>`;
  return html`<${SchemaForm} catalog=${catalog} plan=${plan} values=${draft.values} mode="launch" readOnly level=${level} onLevelChange=${setLevel} testid="wizard.review.schema-form" />`;
}
