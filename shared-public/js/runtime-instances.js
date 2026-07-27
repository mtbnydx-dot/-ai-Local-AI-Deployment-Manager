(function () {
  function create(deps = {}) {
    const {
      $ = (selector) => document.querySelector(selector),
      api,
      escapeHtml = defaultEscape,
      escapeAttr = defaultEscape,
      fmtTokens = (value) => String(value || 0),
      formatDateTime = (value) => String(value || ""),
      renderIcons = () => {},
      notify = () => {},
      reportError = (_title, error) => console.error(error),
      onInstancesChanged = () => {},
      getLanguage = () => "zh-CN",
      engineLabel = "model runtime",
    } = deps;

    let data = { instances: [] };
    let loading = false;

    function copy() {
      const en = getLanguage() === "en-US";
      return en ? {
        empty: `No managed ${engineLabel} instances are running.`,
        primary: "Primary",
        parallel: "Parallel",
        running: "Running",
        stopped: "Stopped",
        model: "Model",
        context: "context",
        port: "Port",
        copy: "Copy local API URL",
        stop: "Stop this instance",
        stopConfirm: "Stop this managed instance? Its model will be unloaded, while other instances stay running.",
        refreshed: "Runtime instances refreshed",
        copied: "API URL copied",
        replaceHint: "Replace primary: only the primary managed container is replaced. Context, concurrency, port, and every other launch value remain exactly as entered.",
        parallelHint: "Add parallel instance: existing containers stay running. Enter a unique instance ID and an unused port; no launch value is changed automatically.",
      } : {
        empty: `当前没有运行中的 ${engineLabel} 管理实例。`,
        primary: "主实例",
        parallel: "并行实例",
        running: "运行中",
        stopped: "已停止",
        model: "模型",
        context: "上下文",
        port: "端口",
        copy: "复制本机 API 地址",
        stop: "停止此实例",
        stopConfirm: "确认停止这个管理实例？该实例的模型会被卸载，其他实例不受影响。",
        refreshed: "运行实例已刷新",
        copied: "API 地址已复制",
        replaceHint: "替换主实例：只替换主容器。上下文、并发、端口和其他启动参数全部严格采用当前输入值。",
        parallelHint: "新增并行实例：保留现有容器。请填写唯一实例标识和未占用端口；管理器不会自动改写任何启动参数。",
      };
    }

    function updateLaunchMode() {
      const mode = $("#instanceMode")?.value === "parallel" ? "parallel" : "replace";
      const field = $("#instanceIdField");
      const input = $("#instanceId");
      if (field) field.hidden = mode !== "parallel";
      if (input) {
        input.disabled = mode !== "parallel";
        input.required = mode === "parallel";
      }
      const hint = $("#instanceModeHint");
      if (hint) hint.textContent = mode === "parallel" ? copy().parallelHint : copy().replaceHint;
      return mode;
    }

    async function refresh(options = {}) {
      if (loading || typeof api !== "function") return data;
      loading = true;
      const root = $("#runtimeInstancesList");
      if (root && !data.instances?.length) root.innerHTML = '<div class="empty compact">Loading...</div>';
      try {
        data = await api("/api/instances");
        render();
        if (!options.silent) notify(copy().refreshed, `${data.instances?.length || 0}`, "success");
        return data;
      } catch (error) {
        if (root) root.innerHTML = `<div class="empty compact error-text">${escapeHtml(error.message)}</div>`;
        if (!options.silent) reportError(copy().refreshed, error);
        throw error;
      } finally {
        loading = false;
      }
    }

    function render() {
      const root = $("#runtimeInstancesList");
      if (!root) return;
      const labels = copy();
      const instances = Array.isArray(data.instances) ? data.instances : [];
      if (!instances.length) {
        root.innerHTML = `<div class="empty compact">${escapeHtml(labels.empty)}</div>`;
        return;
      }
      root.innerHTML = instances.map((instance) => {
        const models = Array.isArray(instance.models) ? instance.models : [];
        const model = models[0] || {};
        const modeLabel = instance.primary ? labels.primary : labels.parallel;
        const stateLabel = instance.running ? labels.running : labels.stopped;
        const stateName = instance.running ? "ok" : "warn";
        const context = model.maxModelLen ? `${fmtTokens(model.maxModelLen)} ${labels.context}` : "";
        const url = instance.localBaseUrl || "";
        return `
          <article class="runtime-instance-row">
            <div class="runtime-instance-main">
              <div class="runtime-instance-title">
                <strong>${escapeHtml(model.id || instance.containerName || instance.id || "-")}</strong>
                <span class="status-pill ${stateName}">${escapeHtml(stateLabel)}</span>
                <span class="pill">${escapeHtml(modeLabel)}</span>
              </div>
              <p>${escapeHtml(instance.containerName || "-")} · ${escapeHtml(labels.port)} ${escapeHtml(instance.port || "-")}${context ? ` · ${escapeHtml(context)}` : ""}</p>
              ${url ? `<code>${escapeHtml(url)}</code>` : ""}
            </div>
            <div class="mini-actions runtime-instance-actions">
              ${url ? `<button type="button" title="${escapeAttr(labels.copy)}" data-instance-action="copy" data-url="${escapeAttr(url)}"><i data-lucide="copy"></i></button>` : ""}
              <button type="button" class="danger" title="${escapeAttr(labels.stop)}" data-instance-action="stop" data-instance-id="${escapeAttr(instance.id || instance.containerName || "")}" data-instance-name="${escapeAttr(instance.containerName || instance.id || "")}"><i data-lucide="square"></i></button>
            </div>
          </article>
        `;
      }).join("");
      renderIcons();
    }

    async function handleListClick(event) {
      const button = event.target.closest("[data-instance-action]");
      if (!button) return;
      const action = button.dataset.instanceAction;
      if (action === "copy") {
        await navigator.clipboard.writeText(button.dataset.url || "");
        notify(copy().copied, button.dataset.url || "", "success");
        return;
      }
      if (action !== "stop" || !window.confirm(copy().stopConfirm)) return;
      button.disabled = true;
      try {
        await api(`/api/instances/${encodeURIComponent(button.dataset.instanceId || "")}/stop`, { method: "POST", body: "{}" });
        await refresh({ silent: true });
        await onInstancesChanged();
      } catch (error) {
        reportError(copy().stop, error);
      } finally {
        button.disabled = false;
      }
    }

    function bind() {
      $("#instanceMode")?.addEventListener("change", updateLaunchMode);
      $("#reloadInstancesBtn")?.addEventListener("click", () => refresh().catch(() => {}));
      $("#runtimeInstancesList")?.addEventListener("click", handleListClick);
      updateLaunchMode();
    }

    return { bind, refresh, render, updateLaunchMode, getData: () => data };
  }

  function defaultEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.LocalAiRuntimeInstances = { create };
}());
