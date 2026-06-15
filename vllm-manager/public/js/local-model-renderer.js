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

  function render(options = {}) {
    const root = options.root || document.querySelector(options.rootSelector || "#modelList");
    if (!root) return;
    const state = options.state || {};
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const escapeAttr = helper(options, "escapeAttr", defaultEscape);
    const fmtBytes = helper(options, "fmtBytes", (value) => `${value} B`);
    const labels = {
      empty: "还没有模型，先从右侧下载或直接输入 Hugging Face ID 启动。",
      localBadge: "Local",
      cacheBadge: "HF Cache",
      useTitle: "填入启动表单",
      deleteTitle: "删除本地模型文件",
      nonGguf: "非 GGUF",
      llamaRequiresGguf: "llama.cpp 需要 GGUF 文件",
      ...(options.labels || {}),
    };
    const local = Array.isArray(state.models?.local) ? state.models.local : [];
    const cached = Array.isArray(state.models?.cached) ? state.models.cached : [];
    const items = [
      ...local.map((model) => ({ ...model, badge: labels.localBadge })),
      ...cached.map((model) => ({ ...model, badge: labels.cacheBadge })),
    ];
    if (!items.length) {
      root.innerHTML = `<div class="empty">${escapeHtml(labels.empty)}</div>`;
      return;
    }
    root.innerHTML = items.map((model) => renderRow(model, {
      escapeHtml,
      escapeAttr,
      fmtBytes,
      labels,
      allowDeleteLocal: options.allowDeleteLocal === true,
      requireGgufForLocal: options.requireGgufForLocal === true,
    })).join("");
    root.querySelectorAll("[data-action='use-model']").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.disabled) return;
        options.onUse?.({
          model: button.dataset.model || "",
          name: button.dataset.name || "",
          format: button.dataset.format || "auto",
        });
      });
    });
    root.querySelectorAll("[data-action='delete-model']").forEach((button) => {
      button.addEventListener("click", () => {
        options.onDelete?.({
          button,
          name: button.dataset.name || "",
          size: button.dataset.size || "",
        });
      });
    });
    if (typeof options.renderIcons === "function") options.renderIcons();
  }

  function renderRow(model, options) {
    const launchFormat = model.hasGguf && !model.hasConfig ? "gguf" : "auto";
    const disabled = options.requireGgufForLocal && model.kind === "local" && !model.hasGguf;
    const title = disabled ? options.labels.llamaRequiresGguf : options.labels.useTitle;
    const nonGgufBadge = disabled ? `<span class="pill fail">${options.escapeHtml(options.labels.nonGguf)}</span>` : "";
    const deleteButton = options.allowDeleteLocal && model.kind === "local"
      ? `<button class="danger" title="${options.escapeAttr(options.labels.deleteTitle)}" data-action="delete-model" data-name="${options.escapeAttr(model.id)}" data-size="${options.escapeAttr(options.fmtBytes(model.size))}"><i data-lucide="trash-2"></i></button>`
      : "";
    return `
      <article class="model-row">
        <div>
          <h4>${options.escapeHtml(model.label)}</h4>
          <p>${options.escapeHtml(model.path)}</p>
          <div>
            <span class="pill">${options.escapeHtml(model.badge)}</span>
            <span class="pill">${options.fmtBytes(model.size)}</span>
            ${model.hasConfig ? `<span class="pill ok">config</span>` : ""}
            ${model.hasGguf ? `<span class="pill warn">GGUF</span>` : ""}
            ${nonGgufBadge}
            ${model.ggufFiles?.[0] ? `<span class="pill">${options.escapeHtml(model.ggufFiles[0].name || "single file")}</span>` : ""}
          </div>
        </div>
        <div class="mini-actions">
          <button title="${options.escapeAttr(title)}" ${disabled ? "disabled" : ""} data-action="use-model" data-model="${options.escapeAttr(model.launchModel)}" data-name="${options.escapeAttr(model.label)}" data-format="${options.escapeAttr(launchFormat)}"><i data-lucide="play"></i></button>
          ${deleteButton}
        </div>
      </article>
    `;
  }

  window.LocalAiLocalModelRenderer = { render };
})();
