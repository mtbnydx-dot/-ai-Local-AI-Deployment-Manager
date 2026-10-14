// Icon (07 §4.4): an inline SVG from the vendored Lucide subset (ui/vendor.js).
// Decorative by default; pass `label` when the icon is the only content.

import { h } from "../ui/html.js";
import { iconAttributes, icons } from "../ui/vendor.js";

// name is a key of the icon subset; label makes it non-decorative.
export function Icon({ name, label, size, spin = false, class: extra = "", testid }) {
  const nodes = icons[name];
  if (!nodes) return null;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": "true", focusable: "false" };
  return h("svg", {
    ...iconAttributes,
    ...a11y,
    class: `icon${size ? ` icon-${size}` : ""}${spin ? " icon-spin" : ""}${extra ? ` ${extra}` : ""}`,
    "data-testid": testid || `icon.${name}`,
  }, nodes.map(([tag, attrs]) => h(tag, attrs)));
}
