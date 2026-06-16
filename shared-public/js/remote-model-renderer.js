(function () {
  function defaultEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function helper(options, name, fallback) {
    return typeof options?.[name] === "function" ? options[name] : fallback;
  }

  function renderCard(model, options) {
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const escapeAttr = helper(options, "escapeAttr", defaultEscape);
    const fmtNumber = helper(options, "fmtNumber", (value) => String(value ?? 0));
    const fmtBytes = helper(options, "fmtBytes", (value) => `${value} B`);
    const formatDate = helper(options, "formatDate", (value) => String(value || "-"));
    const formatParamsB = helper(options, "formatParamsB", (value) => `${value}B`);
    const isRunnable = helper(options, "isRunnableRemoteModel", () => false);
    const labels = {
      authorFallback: "Hugging Face",
      updated: "Updated",
      downloads: "Downloads",
      likes: "Likes",
      params: "Params",
      file: "File",
      largest: "Largest",
      runnableOk: "Runnable",
      runnableWarn: "Use another manager",
      downloadTitle: "Use in download form",
      downloadLabel: "Download",
      startTitle: "Use in launch form",
      startLabel: "Launch",
      readmeTitle: "View model notes",
      openTitle: "Open model page",
      ...(options.labels || {}),
    };
    const quantSet = new Set((model.quantFormats || []).map((item) => String(item).toLowerCase()));
    const badges = (model.badges || [])
      .filter((badge) => {
        const normalized = String(badge || "").toLowerCase();
        if (!normalized) return false;
        if (quantSet.has(normalized)) return false;
        if (normalized === "gguf" && model.hasGguf) return false;
        if (normalized === "safetensors" && model.hasSafetensors) return false;
        if (normalized === "gated" && model.gated) return false;
        return true;
      })
      .slice(0, 7)
      .map((badge) => `<span class="pill">${escapeHtml(badge)}</span>`)
      .join("");
    const gated = model.gated ? `<span class="pill warn">gated</span>` : "";
    const runnable = isRunnable(model)
      ? `<span class="pill ok">${escapeHtml(labels.runnableOk)}</span>`
      : `<span class="pill warn">${escapeHtml(labels.runnableWarn)}</span>`;
    const format = model.hasGguf
      ? `<span class="pill warn">GGUF</span>`
      : model.hasSafetensors
        ? `<span class="pill ok">safetensors</span>`
        : "";
    const quant = (model.quantFormats || []).slice(0, 4)
      .map((item) => `<span class="pill ok">${escapeHtml(item)}</span>`)
      .join("");
    const metrics = [
      model.paramsB ? `${labels.params} ${formatParamsB(model.paramsB)}` : "",
      model.fileSizeBytes ? `${labels.file} ${fmtBytes(model.fileSizeBytes)}` : "",
      model.largestFileBytes ? `${labels.largest} ${fmtBytes(model.largestFileBytes)}` : "",
      model.fileCount ? `${fmtNumber(model.fileCount)} files` : "",
      model.pipelineTag || model.libraryName || "",
    ].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    const showReadme = typeof options.canShowReadme === "function" ? options.canShowReadme(model) : false;
    const readme = showReadme
      ? `<div class="remote-readme" data-readme-for="${escapeAttr(model.id)}" hidden></div>`
      : "";
    const readmeButton = showReadme
      ? `<button title="${escapeAttr(labels.readmeTitle)}" data-action="remote-readme" data-model="${escapeAttr(model.id)}"><i data-lucide="file-text"></i></button>`
      : "";

    return `
      <article class="remote-model-card">
        <div>
          <h4>${escapeHtml(model.label || model.id)}</h4>
          <p>${escapeHtml(model.author || labels.authorFallback)} · ${escapeHtml(labels.updated)} ${escapeHtml(formatDate(model.lastModified))}</p>
          <div class="remote-meta">
            <span>${escapeHtml(labels.downloads)} ${fmtNumber(model.downloads)}</span>
            <span>${escapeHtml(labels.likes)} ${fmtNumber(model.likes)}</span>
            ${metrics}
          </div>
          <div class="pill-row">${runnable}${format}${quant}${gated}${badges}</div>
          ${readme}
        </div>
        <div class="remote-actions">
          <button class="remote-action-primary" title="${escapeAttr(labels.downloadTitle)}" data-action="remote-download" data-model="${escapeAttr(model.id)}" data-output="${escapeAttr(model.outputName)}" data-source="${escapeAttr(model.source || "huggingface")}"><i data-lucide="download"></i><span>${escapeHtml(labels.downloadLabel)}</span></button>
          <button title="${escapeAttr(labels.startTitle)}" data-action="remote-start" data-model="${escapeAttr(model.id)}"><i data-lucide="play"></i><span>${escapeHtml(labels.startLabel)}</span></button>
          ${readmeButton}
          <a title="${escapeAttr(labels.openTitle)}" href="${escapeAttr(model.url)}" target="_blank"><i data-lucide="database"></i></a>
        </div>
      </article>
    `;
  }

  function render(options = {}) {
    const root = options.root || document.querySelector(options.rootSelector || "#remoteModelList");
    if (!root) return;
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const models = Array.isArray(options.models) ? options.models : [];
    if (options.error) {
      root.innerHTML = `<div class="empty">${escapeHtml(options.errorMessage || options.error)}</div>`;
      return;
    }
    if (!models.length) {
      root.innerHTML = `<div class="empty">${escapeHtml(options.emptyMessage || "No matching remote models.")}</div>`;
      return;
    }
    root.innerHTML = models.map((model) => renderCard(model, options)).join("");
    const allModels = Array.isArray(options.allModels) ? options.allModels : models;
    root.querySelectorAll("[data-action='remote-readme']").forEach((button) => {
      button.addEventListener("click", () => options.onReadme?.(button.dataset.model));
    });
    root.querySelectorAll("[data-action='remote-download']").forEach((button) => {
      button.addEventListener("click", () => {
        const selected = allModels.find((model) => model.id === button.dataset.model);
        options.onDownload?.(selected, {
          source: button.dataset.source || "huggingface",
          model: button.dataset.model,
          outputName: button.dataset.output,
        });
      });
    });
    root.querySelectorAll("[data-action='remote-start']").forEach((button) => {
      button.addEventListener("click", () => options.onStart?.(button.dataset.model));
    });
    if (typeof options.renderIcons === "function") options.renderIcons();
  }

  window.remoteModelRenderer = {
    render,
    renderCard,
  };
}());
