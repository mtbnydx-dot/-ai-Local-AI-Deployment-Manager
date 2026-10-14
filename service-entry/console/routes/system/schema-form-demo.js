// /system/ui-kit companion for SchemaForm (CON-10; hidden from the navigation):
// the form in launch mode (editable, with a recipe lock, a planner value and a
// suggestion) and in catalog mode (read-only) over a small demo catalog, for
// the browser specs. It is its own module so the ui-kit page keeps its own
// selectors, and mountSchemaFormDemo() needs no API or router, like mountUiKit.

import { createFormatters } from "../../lib/format.js";
import { createI18n } from "../../lib/i18n.js";
import { applySuggestion, withValue } from "../../lib/schema-form-model.js";
import { createQueryCache } from "../../lib/store.js";
import { createServices, ServicesContext } from "../../ui/context.js";
import { html, render } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { Card } from "../../components/card.js";
import { PageHeader } from "../../components/page-header.js";
import { SchemaForm } from "../../components/schema-form.js";
import { SCHEMA_FORM_CATALOG, SCHEMA_FORM_PLAN, SCHEMA_FORM_VALUES } from "../../data/ui-kit-fixtures.js";

function SchemaFormDemo() {
  const [values, setValues] = useState(SCHEMA_FORM_VALUES);
  const [level, setLevel] = useState("basic");
  return html`<div class="uikit stack" data-ready="true">
    <${PageHeader} title="SchemaForm" />
    <${Card} title="Launch">
      <${SchemaForm} catalog=${SCHEMA_FORM_CATALOG} plan=${SCHEMA_FORM_PLAN} values=${values} level=${level} onLevelChange=${setLevel} engineLabel="demo"
        onChange=${(id, value, field) => setValues((current) => withValue(current, id, value, { keepNull: field?.secret }))}
        onReset=${(id) => setValues((current) => withValue(current, id, undefined))}
        onApplySuggestion=${(id, value, field) => setValues((current) => applySuggestion(current, { id, secret: field?.secret, suggestion: { value } }))} />
    <//>
    <${Card} title="Catalog">
      <${SchemaForm} catalog=${SCHEMA_FORM_CATALOG} mode="catalog" values=${{}} testid="schema-form.catalog" />
    <//>
    <pre data-testid="demo.values" class="sr-only">${JSON.stringify(values)}</pre>
  </div>`;
}

export default SchemaFormDemo;

/**
 * Renders the demo into `root` with a minimal service set.
 * @param catalog the merged i18n catalog of `locale`
 * @returns a function that unmounts the page
 */
export function mountSchemaFormDemo(root, { catalog = {}, locale = "en-US" } = {}) {
  const services = createServices({ api: {}, cache: createQueryCache(), i18n: createI18n({ locale, catalog }), formatters: createFormatters(locale) });
  root.replaceChildren?.();
  render(html`<${ServicesContext.Provider} value=${services}><main id="main"><${SchemaFormDemo} /></main><//>`, root);
  return () => render(null, root);
}
