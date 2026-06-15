(function () {
  function defaultEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

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

    return `
      <button class="model-picker-item" type="button"
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

    popover.classList.toggle("hidden", !state.modelPickerOpen);
    getElement(options, options.toggleSelector || "#modelPickerToggle")
      ?.setAttribute("aria-expanded", state.modelPickerOpen ? "true" : "false");

    if (typeof options.renderRunnableFilterToggles === "function") {
      options.renderRunnableFilterToggles();
    }

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

    if (!items.length) {
      const escapeHtml = getHelper(options, "escapeHtml", defaultEscape);
      list.innerHTML = `<div class="empty compact">${escapeHtml(options.emptyMessage || "No matching models.")}</div>`;
      return [];
    }

    const maxItems = options.maxItems || 80;
    const visibleItems = items.slice(0, maxItems);
    const footer = items.length > maxItems
      ? `<div class="model-picker-footer">${defaultEscape(options.limitMessage || `Showing first ${maxItems} of ${items.length}. Keep typing to narrow results.`)}</div>`
      : "";
    list.innerHTML = visibleItems.map((item) => renderItem(item, options)).join("") + footer;
    if (typeof options.renderIcons === "function") options.renderIcons();
    return items;
  }

  window.modelPickerRenderer = {
    render,
    renderItem,
  };
}());
