(function (global) {
  "use strict";

  const LIST_LIMITS = Object.freeze({ compact: 6, standard: 80, large: 300 });

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function stateKey(element, index = 0) {
    if (!(element instanceof Element)) return "";
    const explicit = element.getAttribute("data-state-key")
      || element.getAttribute("data-render-key")
      || element.id;
    if (explicit) return `${element.tagName}:${explicit}`;
    const action = element.getAttribute("data-action")
      || element.getAttribute("data-fleet-action")
      || element.getAttribute("data-instance-action")
      || element.getAttribute("name");
    const subject = element.getAttribute("data-id")
      || element.getAttribute("data-instance-id")
      || element.getAttribute("data-instance-name")
      || element.getAttribute("data-model")
      || element.getAttribute("value");
    return `${element.tagName}:${action || element.className || "node"}:${subject || index}`;
  }

  function captureState(root) {
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const controls = Array.from(root.querySelectorAll("details, [aria-expanded], input, textarea, select, [data-preserve-scroll]"));
    const values = controls.map((element, index) => ({
      key: stateKey(element, index),
      open: element instanceof HTMLDetailsElement ? element.open : undefined,
      expanded: element.hasAttribute("aria-expanded") ? element.getAttribute("aria-expanded") : undefined,
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? element.value
        : undefined,
      scrollTop: element.hasAttribute("data-preserve-scroll") ? element.scrollTop : undefined,
      scrollLeft: element.hasAttribute("data-preserve-scroll") ? element.scrollLeft : undefined,
    }));
    return {
      activeKey: active ? stateKey(active, controls.indexOf(active)) : "",
      selectionStart: active && "selectionStart" in active ? active.selectionStart : null,
      selectionEnd: active && "selectionEnd" in active ? active.selectionEnd : null,
      rootScrollTop: root.scrollTop,
      rootScrollLeft: root.scrollLeft,
      values,
    };
  }

  function restoreState(root, state) {
    if (!state) return;
    const candidates = Array.from(root.querySelectorAll("details, [aria-expanded], input, textarea, select, button, a, [tabindex], [data-preserve-scroll]"));
    const byKey = new Map(candidates.map((element, index) => [stateKey(element, index), element]));
    state.values.forEach((item) => {
      const element = byKey.get(item.key);
      if (!element) return;
      if (item.open !== undefined && element instanceof HTMLDetailsElement) element.open = item.open;
      if (item.expanded !== undefined) element.setAttribute("aria-expanded", item.expanded);
      if (item.checked !== undefined && "checked" in element) element.checked = item.checked;
      if (item.value !== undefined && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
        element.value = item.value;
      }
      if (item.scrollTop !== undefined) element.scrollTop = item.scrollTop;
      if (item.scrollLeft !== undefined) element.scrollLeft = item.scrollLeft;
    });
    root.scrollTop = state.rootScrollTop;
    root.scrollLeft = state.rootScrollLeft;
    const active = byKey.get(state.activeKey);
    if (active && typeof active.focus === "function") {
      active.focus({ preventScroll: true });
      if (state.selectionStart !== null && typeof active.setSelectionRange === "function") {
        active.setSelectionRange(state.selectionStart, state.selectionEnd ?? state.selectionStart);
      }
    }
  }

  function setHtmlIfChanged(root, html, options = {}) {
    if (!root) return false;
    const next = String(html ?? "");
    if (root.innerHTML === next) return false;
    const state = options.preserveState === false ? null : captureState(root);
    root.innerHTML = next;
    restoreState(root, state);
    return true;
  }

  global.LocalAiDomUtils = Object.freeze({
    LIST_LIMITS,
    escapeHtml,
    escapeAttr,
    setHtmlIfChanged,
  });
})(window);
