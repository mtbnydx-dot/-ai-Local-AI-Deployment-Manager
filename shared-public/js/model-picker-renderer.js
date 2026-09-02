(function () {
  // Last markup written per list element, so a poll that produces identical
  // output does not touch the DOM at all. Kept off the element itself to avoid
  // serialising a large string into a data- attribute.
  const renderedHtml = new WeakMap();

  const defaultEscape = (value) => window.LocalAiDomUtils.escapeHtml(value);

  function getHelper(options, name, fallback) {
    return typeof options?.[name] === "function" ? options[name] : fallback;
  }

  function getElement(options, selector) {
    const query = getHelper(options, "getElement", (value) => document.querySelector(value));
    return query(selector);
  }

  function getMetricLabels(options) {
    return {
      size: "Size",
      quant: "Quant",
      gpu: "GPU",
      speed: "Speed",
      updated: "Updated",
      ...(options?.metricLabels || {}),
    };
  }

  function renderItem(item, options = {}) {
    const escapeHtml = getHelper(options, "escapeHtml", defaultEscape);
    const escapeAttr = getHelper(options, "escapeAttr", defaultEscape);
    const fmtBytes = getHelper(options, "fmtBytes", (value) => `${value} B`);
    const formatDate = getHelper(options, "formatDate", (value) => String(value || ""));
    const estimateModelFit = getHelper(options, "estimateModelFit", () => null);
    const favoriteLabel = options.favoriteLabel || "Favorite";
    const labels = getMetricLabels(options);
    const badges = (item.badges || []).slice(0, options.maxBadges || 8).map((badge) => {
      const className = item.favorite && badge === favoriteLabel ? "favorite" : "";
      return `<span class="${className}">${escapeHtml(badge)}</span>`;
    }).join("");
    const fit = estimateModelFit(item);
    const speed = Number(item.runningSpeed);
    const metrics = [
      item.sizeBytes ? { label: labels.size, value: fmtBytes(item.sizeBytes) } : null,
      item.quantLabel ? { label: labels.quant, value: item.quantLabel } : null,
      fit ? { label: labels.gpu, value: fit.label, state: fit.state } : null,
      Number.isFinite(speed) && speed > 0 ? { label: labels.speed, value: `${speed.toFixed(1)} tok/s` } : null,
      item.updatedAt ? { label: labels.updated, value: formatDate(item.updatedAt) } : null,
    ].filter(Boolean).map((metric) => `
      <span class="model-picker-metric ${metric.state ? `fit-${escapeAttr(metric.state)}` : ""}">
        <em>${escapeHtml(metric.label)}</em><b>${escapeHtml(metric.value)}</b>
      </span>
    `).join("");
    const accessibleName = [
      item.label || item.model,
      item.sourceLabel,
      fit?.label,
      item.disabledReason,
    ].filter(Boolean).join(" / ");

    return `
      <button class="model-picker-item" type="button" ${item.disabled ? "disabled" : ""}
        title="${escapeAttr(item.disabledReason || "")}"
        aria-label="${escapeAttr(accessibleName)}"
        data-picker-model="${escapeAttr(item.model)}"
        data-picker-name="${escapeAttr(item.label || item.model)}"
        data-picker-format="${escapeAttr(item.format || "auto")}"
        data-picker-source="${escapeAttr(item.source)}">
        <span class="model-picker-main">
          <strong>${escapeHtml(item.label || item.model)}</strong>
          <small>${escapeHtml(item.detail || item.model)}</small>
          ${metrics ? `<span class="model-picker-metrics">${metrics}</span>` : ""}
        </span>
        <span class="model-picker-badges">${badges}</span>
      </button>
    `;
  }

  function itemMatchesSearch(item, search) {
    if (!search) return true;
    return [item.label, item.model, item.detail, item.sourceLabel, ...(item.badges || [])]
      .join(" ")
      .toLowerCase()
      .includes(search);
  }

  function render(options = {}) {
    const state = options.state || {};
    const popover = getElement(options, options.popoverSelector || "#modelPickerPopover");
    const list = getElement(options, options.listSelector || "#modelPickerList");
    if (!popover || !list) return [];

    ensureDialogStructure(popover, options);

    popover.classList.toggle("hidden", !state.modelPickerOpen);
    const toggle = getElement(options, options.toggleSelector || "#modelPickerToggle");
    toggle?.setAttribute("aria-expanded", state.modelPickerOpen ? "true" : "false");
    const backdrop = document.querySelector(".model-picker-backdrop");
    backdrop?.classList.toggle("hidden", !state.modelPickerOpen);
    document.body.classList.toggle("model-picker-open", Boolean(state.modelPickerOpen));
    if (!state.modelPickerOpen && popover.dataset.wasOpen === "true") toggle?.focus({ preventScroll: true });
    popover.dataset.wasOpen = state.modelPickerOpen ? "true" : "false";

    if (typeof options.renderRunnableFilterToggles === "function") {
      options.renderRunnableFilterToggles();
    }

    // This runs on every status poll. Building the item list walks running,
    // local, cached and remote models and maps notes over them, so doing it
    // while the picker is closed is pure waste -- and rewriting the list would
    // reset the user's scroll position for no reason.
    if (!state.modelPickerOpen && options.skipWhenClosed !== false) return [];

    const source = state.modelPickerSource || "all";
    document.querySelectorAll(options.tabSelector || "#modelPickerTabs [data-model-source]").forEach((button) => {
      button.classList.toggle("active", button.dataset.modelSource === source);
    });

    const searchElement = getElement(options, options.searchSelector || "#modelPickerSearch");
    const search = (searchElement?.value || "").trim().toLowerCase();
    const buildItems = getHelper(options, "buildItems", () => []);
    let items = buildItems();
    if (!Array.isArray(items)) items = [];
    if (source !== "all") items = items.filter((item) => item.source === source);
    if (state.runnableOnly && typeof options.isRunnableItem === "function") {
      items = items.filter(options.isRunnableItem);
    }
    items = items.filter((item) => itemMatchesSearch(item, search));

    let nextHtml;
    if (!items.length) {
      const escapeHtml = getHelper(options, "escapeHtml", defaultEscape);
      nextHtml = `<div class="empty compact">${escapeHtml(options.emptyMessage || "No matching models.")}</div>`;
    } else {
      const maxItems = options.maxItems || 80;
      const visibleItems = items.slice(0, maxItems);
      const footer = items.length > maxItems
        ? `<div class="model-picker-footer">${defaultEscape(options.limitMessage || `Showing first ${maxItems} of ${items.length}. Keep typing to narrow results.`)}</div>`
        : "";
      nextHtml = visibleItems.map((item) => renderItem(item, options)).join("") + footer;
    }

    // Skip the write when nothing changed: no reflow, no flicker, and no scroll
    // jump on the common steady-state poll.
    if (renderedHtml.get(list) === nextHtml) return items;

    // The list is scrollable and gets rebuilt by a 5s poll, so without this the
    // user is thrown back to the top every few seconds while browsing models.
    const previousScrollTop = list.scrollTop;
    list.innerHTML = nextHtml;
    renderedHtml.set(list, nextHtml);
    if (previousScrollTop > 0 && list.scrollHeight > list.clientHeight) {
      list.scrollTop = Math.min(previousScrollTop, list.scrollHeight - list.clientHeight);
    }
    if (typeof options.renderIcons === "function") options.renderIcons();
    return items;
  }

  function ensureDialogStructure(popover, options) {
    const dialogId = popover.id || "modelPickerPopover";
    const titleId = `${dialogId}Title`;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-modal", "true");
    popover.setAttribute("aria-labelledby", titleId);
    if (!popover.querySelector(".model-picker-dialog-head")) {
      const head = document.createElement("div");
      head.className = "model-picker-dialog-head";
      head.innerHTML = `
        <div><strong id="${titleId}">${defaultEscape(options.dialogTitle || "选择模型")}</strong><span>${defaultEscape(options.dialogDescription || "按来源、格式和可用资源筛选启动模型。")}</span></div>
        <button class="icon-button model-picker-close" type="button" aria-label="关闭模型选择器" title="关闭"><span aria-hidden="true">×</span></button>
      `;
      popover.prepend(head);
      head.querySelector(".model-picker-close")?.addEventListener("click", () => options.onClose?.());
    }
    let backdrop = document.querySelector(".model-picker-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "model-picker-backdrop hidden";
      backdrop.setAttribute("aria-hidden", "true");
      document.body.appendChild(backdrop);
      backdrop.addEventListener("click", () => backdrop.__onClose?.());
    }
    backdrop.__onClose = options.onClose;
    if (!popover.__dialogKeyboardBound) {
      popover.__dialogKeyboardBound = true;
      document.addEventListener("keydown", (event) => {
        if (popover.classList.contains("hidden")) return;
        if (event.key === "Escape") {
          event.preventDefault();
          options.onClose?.();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(popover.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }
  }

  function create(defaults = {}) {
    return {
      render: (options = {}) => render({ ...defaults, ...options }),
      renderItem: (item, options = {}) => renderItem(item, { ...defaults, ...options }),
    };
  }

  const api = {
    create,
    render,
    renderItem,
  };
  window.LocalAiModelPickerRenderer = api;
  window.modelPickerRenderer = api;
}());
