// Tabs (07 §4.4, §9): a WAI-ARIA tablist with a roving tabindex. Left/Right
// wrap, Home/End jump; with activation "auto" focus selects, with "manual"
// Enter or Space selects. The active id mirrors into ?tab= (replaceState, so
// the Back button is not flooded), and the panel is role=tabpanel tabindex=0.

import { html } from "../ui/html.js";
import { useId, useRef, useState } from "../ui/vendor.js";

/** Sets or removes one query parameter without adding a history entry (Drawer shares it). */
export function replaceQueryParam(name, value) {
  try {
    const url = new URL(globalThis.location.href);
    if (value === null || value === undefined || value === "") url.searchParams.delete(name);
    else url.searchParams.set(name, String(value));
    globalThis.history.replaceState(globalThis.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Without a history (tests, previews) the state simply stays in memory.
  }
}

export function readQueryParam(name) {
  try {
    return new URL(globalThis.location.href).searchParams.get(name);
  } catch {
    return null;
  }
}

/** The index a key moves to from `from` (disabled tabs skipped, ends wrap), or -1 for a key that does not navigate. */
export function nextTabIndex(tabs, from, key) {
  const count = tabs.length;
  const enabled = (index) => !tabs[index].disabled;
  if (key === "Home") return tabs.findIndex((_, index) => enabled(index));
  if (key === "End") {
    for (let index = count - 1; index >= 0; index -= 1) if (enabled(index)) return index;
    return -1;
  }
  const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (!step) return -1;
  for (let hop = 1; hop <= count; hop += 1) {
    const index = (((from + step * hop) % count) + count) % count;
    if (enabled(index)) return index;
  }
  return -1;
}

// tabs [{ id, label, badge?, disabled? }]; value controls it; children is the active panel.
export function Tabs({ tabs = [], value, onChange, urlParam = "tab", activation = "auto", label, renderPanel, testid, children }) {
  const base = useId();
  const refs = useRef({});
  const usable = (id) => tabs.some((tab) => tab.id === id && !tab.disabled);
  const [own, setOwn] = useState(() => {
    const fromUrl = urlParam ? readQueryParam(urlParam) : null;
    return usable(fromUrl) ? fromUrl : tabs.find((tab) => !tab.disabled)?.id;
  });
  const [focusId, setFocusId] = useState(null);
  const active = value !== undefined ? value : own;

  function select(id) {
    if (value === undefined) setOwn(id);
    if (urlParam) replaceQueryParam(urlParam, id);
    onChange?.(id);
  }

  function onKeyDown(event, index) {
    const next = nextTabIndex(tabs, index, event.key);
    if (next < 0) return;
    event.preventDefault();
    const target = tabs[next];
    setFocusId(target.id);
    refs.current[target.id]?.focus();
    if (activation === "auto") select(target.id);
  }

  const panel = renderPanel ? renderPanel(active) : children;
  const stop = focusId !== null && usable(focusId) ? focusId : active;
  return html`<div class="tabs-wrap" data-testid=${testid || "tabs.root"}>
    <div class="tabs" role="tablist" aria-label=${label}
      onFocusOut=${(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusId(null);
      }}>
      ${tabs.map((tab, index) => html`<button key=${tab.id} type="button" role="tab" class="tab" id=${`${base}-tab-${tab.id}`}
        ref=${(node) => {
          refs.current[tab.id] = node;
        }}
        aria-selected=${tab.id === active ? "true" : "false"} aria-controls=${tab.id === active && panel != null ? `${base}-panel` : undefined}
        tabindex=${tab.id === stop ? "0" : "-1"} disabled=${Boolean(tab.disabled)} data-testid="tabs.tab"
        onClick=${() => select(tab.id)} onKeyDown=${(event) => onKeyDown(event, index)}>
        ${tab.label}${tab.badge !== undefined && tab.badge !== null ? html`<span class="tab-badge">${tab.badge}</span>` : null}
      </button>`)}
    </div>
    ${panel != null ? html`<div role="tabpanel" id=${`${base}-panel`} aria-labelledby=${`${base}-tab-${active}`} tabindex="0" class="tab-panel" data-testid="tabs.panel">${panel}</div>` : null}
  </div>`;
}
