// Small pieces the engine cards and the engine detail header share (07 §6.5).

import { capabilityChips, engineHealth, engineTier } from "../../lib/engines-model.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

const TIER_TONE = Object.freeze({ builtin: "badge-info", experimental: "badge-warn", custom: "badge-neutral", external: "badge-neutral" });

/** 内置 Built-in / 实验 Experimental / 自定义 Custom / 外部 External. */
export function TierBadge({ engine }) {
  const { t, tk } = useT();
  const tier = engineTier(engine);
  return html`<span class=${`badge ${TIER_TONE[tier]}`} data-tier=${tier} data-testid="engine.tier">${t(tk("engines.page.tier.", tier))}</span>`;
}

export function HealthBadge({ engine }) {
  const { t, tk } = useT();
  const health = engineHealth(engine);
  return html`<${StatusBadge} status=${health} label=${t(tk("engines.page.health.", health))} testid="engine.health" />`;
}

export function CapabilityChips({ engine }) {
  const { t, tk } = useT();
  const chips = capabilityChips(engine);
  if (!chips.length) return null;
  return html`<ul class="row" aria-label=${t("engines.page.capabilities")} data-testid="engine.capabilities">
    ${chips.map((id) => html`<li key=${id} class="badge badge-neutral" data-capability=${id}>${t(tk("engines.page.cap.", id))}</li>`)}
  </ul>`;
}

/** A table that scrolls sideways on a narrow screen: focusable and named, so the keyboard can scroll it. */
export function TableWrap({ label, children }) {
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label=${label}>${children}</div>`;
}

/** The manager's display name: `vllm` → vLLM, `llama` → llama.cpp; an unknown id shows as it is. */
export function managerName(t, has, tk, managerId) {
  const key = tk("engines.page.manager.", managerId);
  return has(key) ? t(key) : managerId;
}
