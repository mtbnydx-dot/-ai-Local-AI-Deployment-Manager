(function () {
  function create(deps = {}) {
    const {
      $,
      state,
      escapeHtml,
      escapeAttr,
      fmtTokens,
      formatDateTime = (value) => new Date(value).toLocaleString(),
      copy = {},
    } = deps;

    const text = {
      empty: "暂无客户端 Key。创建后明文只显示一次。",
      enabled: "启用",
      disabled: "停用",
      allModels: "全部模型",
      requests: "请求",
      tokens: "tokens",
      unused: "未使用",
      toggleDisable: "停用",
      toggleEnable: "启用",
      rotate: "轮换",
      remove: "删除",
      secretTitle: "客户端 Key",
      secretHelp: "只显示这一次。请放入客户端的 Bearer Token / API Key 字段。",
      ...copy,
    };

    function renderServiceClients() {
      const root = $("#serviceClientList");
      if (!root) return;
      const clients = state.serviceClients?.clients || [];
      if (!clients.length) {
        root.innerHTML = `<div class="empty compact">${escapeHtml(text.empty)}</div>`;
        return;
      }
      root.innerHTML = clients.map(renderServiceClientCard).join("");
    }

    function renderServiceClientCard(client) {
      const enabled = client.enabled !== false;
      const allowedModels = (client.allowedModels || []).join(", ") || text.allModels;
      const lastUsed = client.lastUsedAt ? formatDateTime(client.lastUsedAt) : text.unused;
      return `
        <article class="service-client-card ${enabled ? "enabled" : "disabled"}" data-client-id="${escapeAttr(client.id)}">
          <div class="service-client-main">
            <strong>${escapeHtml(client.name || client.id)}</strong>
            <code>${escapeHtml(client.keyPreview || "-")}</code>
            <span>${enabled ? text.enabled : text.disabled} · ${escapeHtml(allowedModels)} · ${fmtTokens(client.rateLimitRpm || 0)} req/min · 并发 ${fmtTokens(client.maxConcurrentRequests || 0)}</span>
          </div>
          <div class="service-client-usage">
            <span>${fmtTokens(client.usage?.requests?.total || 0)} ${escapeHtml(text.requests)}</span>
            <span>${fmtTokens(client.usage?.tokens?.total || 0)} ${escapeHtml(text.tokens)}</span>
            <span>${escapeHtml(lastUsed)}</span>
          </div>
          <div class="service-client-actions">
            <button class="ghost-mini-button" data-client-action="toggle" type="button">${enabled ? text.toggleDisable : text.toggleEnable}</button>
            <button class="ghost-mini-button" data-client-action="rotate" type="button">${escapeHtml(text.rotate)}</button>
            <button class="ghost-mini-button danger-text" data-client-action="delete" type="button">${escapeHtml(text.remove)}</button>
          </div>
        </article>
      `;
    }

    function showServiceClientSecret(apiKey, title) {
      const box = $("#serviceClientSecret");
      if (!box) return;
      box.hidden = false;
      box.innerHTML = `
        <strong>${escapeHtml(title || text.secretTitle)}</strong>
        <code>${escapeHtml(apiKey || "")}</code>
        <small>${escapeHtml(text.secretHelp)}</small>
      `;
    }

    return {
      renderServiceClients,
      showServiceClientSecret,
    };
  }

  window.LocalAiServiceClients = { create };
})();
