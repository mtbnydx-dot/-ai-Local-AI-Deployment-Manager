(function () {
  function renderRuntimeFacts(status, helpers) {
    const root = document.querySelector("#runtimeFactsGrid");
    if (!root) return;
    const models = status?.runningModels || [];
    if (!status?.container?.running || !models.length) {
      root.innerHTML = '<div class="empty compact">启动模型后这里会显示实测上下文、KV cache 与加载配置。</div>';
      return;
    }
    const model = models[0];
    const formatContextUsage = helpers.formatContextUsage;
    const fmtTokens = helpers.fmtTokens;
    const escapeHtml = helpers.escapeHtml;
    const maxLen = model.maxModelLen ? `${fmtTokens(model.maxModelLen)} / 槽` : "未报告";
    const activeKv = formatContextUsage(model.contextUsedTokens, model.contextCapacityTokens, model.contextUsagePercent);
    const capacity = model.contextCapacityTokens ? `${fmtTokens(model.contextCapacityTokens)} tokens` : "等待 llama.cpp 指标";
    const config = status?.runtimeFacts || status?.facts || status?.launchConfig || model?.config || {};
    const cache = [config.cacheTypeK || model.cacheTypeK, config.cacheTypeV || model.cacheTypeV].filter(Boolean).join(" / ") || "未报告";
    const gpuPlan = [config.gpuLayers ?? model.gpuLayers, config.tensorSplit || model.tensorSplit].filter((value) => value !== undefined && value !== null && value !== "").join(" · split ") || "未报告";
    const components = [
      config.mmproj || model.mmproj ? "MMProj" : "",
      config.dflash || config.draftModel || model.dflash ? "DFlash" : "",
    ].filter(Boolean).join(" + ") || "纯文本 / 无附属组件";
    root.innerHTML = [
      { label: "每槽上下文", value: maxLen, detail: "来自当前运行实例" },
      { label: "总 KV 容量", value: capacity, detail: "所有并行槽共享的 KV 预算" },
      { label: "当前活跃 KV", value: activeKv, detail: "只代表正在运行的请求" },
      { label: "KV 精度", value: cache, detail: "K / V cache type" },
      { label: "GPU layers / split", value: gpuPlan, detail: "实际启动配置，缺失时不猜测" },
      { label: "附属组件", value: components, detail: "视觉 projector 与推测解码" },
    ].map((item) => `
      <div class="runtime-fact">
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.value)}</strong>
        <small>${escapeHtml(item.detail)}</small>
      </div>
    `).join("");
  }

  window.LlamaRuntimeInsights = { renderRuntimeFacts };
})();
