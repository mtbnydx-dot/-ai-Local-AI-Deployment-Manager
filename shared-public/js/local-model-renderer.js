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
    const formatDateTime = helper(options, "formatDateTime", (value) => String(value || ""));
    const labels = {
      empty: "还没有模型，先从右侧下载或直接输入 Hugging Face ID 启动。",
      localBadge: "Local",
      cacheBadge: "HF Cache",
      useTitle: "填入启动表单",
      deleteTitle: "删除本地模型文件",
      nonGguf: "非 GGUF",
      llamaRequiresGguf: "llama.cpp 需要 GGUF 文件",
      favorite: "收藏",
      note: "备注",
      lastFailure: "最近失败",
      invalidModel: "模型校验失败",
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
      state,
      formatDateTime,
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
    const verificationFailure = model.runnable === false
      ? (model.verificationIssues || []).find((item) => item.severity === "fail")
      : null;
    const ggufDisabled = options.requireGgufForLocal && model.kind === "local" && !model.hasGguf;
    const disabled = model.runnable === false || ggufDisabled;
    const title = verificationFailure?.detail || (ggufDisabled ? options.labels.llamaRequiresGguf : options.labels.useTitle);
    const nonGgufBadge = ggufDisabled ? `<span class="pill fail">${options.escapeHtml(options.labels.nonGguf)}</span>` : "";
    const invalidBadge = verificationFailure ? `<span class="pill fail">${options.escapeHtml(options.labels.invalidModel)}</span>` : "";
    const deleteButton = options.allowDeleteLocal && model.kind === "local"
      ? `<button class="danger" title="${options.escapeAttr(options.labels.deleteTitle)}" data-action="delete-model" data-name="${options.escapeAttr(model.id)}" data-size="${options.escapeAttr(options.fmtBytes(model.size))}"><i data-lucide="trash-2"></i></button>`
      : "";
    const note = findModelNote(model, options.state);
    const failure = findLatestModelFailure(model, options.state);
    const tags = Array.isArray(note?.tags) ? note.tags : [];
    const libraryDetails = note || failure ? `
      <div class="model-library-details">
        ${note?.favorite ? `<span class="pill ok"><i data-lucide="star"></i>${options.escapeHtml(options.labels.favorite)}</span>` : ""}
        ${tags.map((tag) => `<span class="pill">${options.escapeHtml(tag)}</span>`).join("")}
        ${note?.note ? `<p class="model-note-text"><strong>${options.escapeHtml(options.labels.note)}:</strong> ${options.escapeHtml(note.note)}</p>` : ""}
        ${failure ? `<p class="model-failure-note"><strong>${options.escapeHtml(options.labels.lastFailure)}:</strong> ${options.escapeHtml(options.formatDateTime(failure.at))} · ${options.escapeHtml(failure.error)}</p>` : ""}
      </div>
    ` : "";
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
            ${invalidBadge}
            ${model.ggufFiles?.[0] ? `<span class="pill">${options.escapeHtml(model.ggufFiles[0].name || "single file")}</span>` : ""}
          </div>
          ${libraryDetails}
        </div>
        <div class="mini-actions">
          <button title="${options.escapeAttr(title)}" ${disabled ? "disabled" : ""} data-action="use-model" data-model="${options.escapeAttr(model.launchModel)}" data-name="${options.escapeAttr(model.label)}" data-format="${options.escapeAttr(launchFormat)}"><i data-lucide="play"></i></button>
          ${deleteButton}
        </div>
      </article>
    `;
  }

  function normalizeModelRef(value) {
    return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
  }

  function modelRefs(model) {
    return [model.id, model.label, model.path, model.launchModel]
      .map(normalizeModelRef)
      .filter(Boolean);
  }

  function refsMatch(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    const leftName = left.split("/").at(-1);
    const rightName = right.split("/").at(-1);
    return Boolean(leftName && rightName && leftName === rightName && leftName.length >= 6);
  }

  function findModelNote(model, state) {
    const refs = modelRefs(model);
    return Object.values(state?.modelNotes?.notes || {}).find((note) => {
      const noteRef = normalizeModelRef(note?.model);
      return refs.some((ref) => refsMatch(ref, noteRef));
    }) || null;
  }

  function findLatestModelFailure(model, state) {
    const refs = modelRefs(model);
    return (Array.isArray(state?.jobs) ? state.jobs : [])
      .filter((job) => job?.status === "failed" && ["serve", "download"].includes(job.type))
      .map((job) => {
        const meta = job.meta || {};
        const jobRefs = [meta.model, meta.localDir, meta.outputName, meta.name].map(normalizeModelRef).filter(Boolean);
        return {
          matches: refs.some((ref) => jobRefs.some((jobRef) => refsMatch(ref, jobRef))),
          at: job.updatedAt || job.finishedAt || job.createdAt,
          error: String(job.error || (job.logs || []).at(-1) || "unknown error").replace(/\s+/g, " ").slice(0, 240),
        };
      })
      .filter((item) => item.matches)
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null;
  }

  window.LocalAiLocalModelRenderer = { render };
})();
