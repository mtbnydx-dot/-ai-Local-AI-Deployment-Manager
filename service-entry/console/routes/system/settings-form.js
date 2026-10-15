// The settings form of /system/settings (07 §4.5 config mode), loaded when the
// page has its data so the page module itself stays small (07 §11: a route
// module keeps its own static imports under 60 KB). It is SchemaForm with the
// platform's provenance copy (platform.source.*).

import { SchemaForm } from "../../components/schema-form.js";
import { html } from "../../ui/html.js";

export function SettingsForm(props) {
  return html`<${SchemaForm} mode="config" sourcePrefix="platform.source." ...${props} />`;
}
