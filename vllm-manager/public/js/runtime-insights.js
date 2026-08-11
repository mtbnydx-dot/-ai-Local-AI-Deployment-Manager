(function () {
  function renderRuntimeFacts(status, helpers) {
    const root = document.querySelector("#runtimeFactsGrid");
    if (!root) return;
    const models = status?.runningModels || [];
    if (!status?.container?.running || !models.length) {
      root.innerHTML = '<div class="empty compact">启动模型后这里会显示当前运行实例的实测上下文和 KV cache。</div>';
      return;
    }
    const model = models[0];
    const formatContextUsage = helpers.formatContextUsage;
    const fmtTokens = helpers.fmtTokens;
    const escapeHtml = helpers.escapeHtml;
    const maxLen = model.maxModelLen ? `${fmtTokens(model.maxModelLen)} tokens` : "未报告";
    const activeKv = formatContextUsage(model.contextUsedTokens, model.contextCapacityTokens, model.contextUsagePercent);
    const capacity = model.contextCapacityTokens ? `${fmtTokens(model.contextCapacityTokens)} tokens` : "等待 vLLM 启动事实";
    const totalTokens = fmtTokens(Number(model.promptTokens || 0) + Number(model.outputTokens || 0));
    root.innerHTML = [
      { label: "实测上限", value: maxLen, detail: "来自 /v1/models 的 max_model_len" },
      { label: "KV 容量", value: capacity, detail: "来自启动日志并持久化保存" },
      { label: "当前活跃 KV", value: activeKv, detail: "只代表正在运行的请求" },
      { label: "累计吞吐", value: `${totalTokens} tokens`, detail: `${fmtTokens(model.requests || 0)} 个请求` },
    ].map((item) => `
      <div class="runtime-fact">
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.value)}</strong>
        <small>${escapeHtml(item.detail)}</small>
      </div>
    `).join("");
  }

  window.VllmRuntimeInsights = { renderRuntimeFacts };
})();
