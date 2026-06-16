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
    const getElement = helper(options, "getElement", (selector) => document.querySelector(selector));
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const escapeAttr = helper(options, "escapeAttr", defaultEscape);
    const formatDate = helper(options, "formatDate", (value) => String(value || "-"));
    const fmtTokens = helper(options, "fmtTokens", (value) => String(value ?? 0));
    const fmtBytes = helper(options, "fmtBytes", (value) => String(value ?? "-"));
    const renderIcons = helper(options, "renderIcons", () => {});
    const state = options.state || {};
    const status = state.auditStatus;
    const authed = Boolean(state.auditToken);
    const statusRoot = getElement("#auditStatusBox");
    const loginPanel = getElement("#auditLoginPanel");
    const adminPanel = getElement("#auditAdminPanel");
    if (!statusRoot || !loginPanel || !adminPanel) return;

    statusRoot.innerHTML = status ? `
      <strong>审计目录：${escapeHtml(status.auditRoot || "-")}</strong>
      <span>Open WebUI 容器：${escapeHtml(status.openWebuiContainer || "-")} · ${status.container?.running ? "运行中" : status.container?.exists ? "已停止" : "未找到"}</span>
      <span>密码文件：${escapeHtml(status.passwordFile || "-")}</span>
    ` : "正在读取审计状态...";

    loginPanel.classList.toggle("hidden", authed);
    adminPanel.classList.toggle("hidden", !authed);
    getElement("#auditError").textContent = state.auditError || "";

    if (!authed) {
      getElement("#auditList").innerHTML = `<div class="empty compact">输入审计密码后才能查看完整对话记录。</div>`;
      getElement("#auditMarkdownViewer").textContent = "审计内容未解锁。";
      getElement("#auditSelectedMeta").textContent = "完整 Markdown 只会在密码通过后由浏览器读取。";
      renderIcons();
      return;
    }

    const exports = state.auditExports || [];
    if (!exports.length) {
      getElement("#auditList").innerHTML = `<div class="empty compact">暂无审计导出。卸载模型后会自动生成，也可以手动生成一次。</div>`;
    } else {
      getElement("#auditList").innerHTML = exports.map((item) => `
        <article class="audit-row ${item.auditId === state.selectedAuditId ? "selected" : ""}">
          <div>
            <h4>${escapeHtml(item.auditId)}</h4>
            <p>${escapeHtml(item.auditDir || "")}</p>
            <div class="running-meta">
              <span>${escapeHtml(item.reason || "manual")}</span>
              <span>${escapeHtml(item.manager || "-")}</span>
              <span>${escapeHtml(formatDate(item.createdAt))}</span>
              <span>${fmtTokens(item.chatCount)} chats</span>
              <span>${fmtTokens(item.messageCount)} messages</span>
              <span>${fmtBytes(item.mdBytes)}</span>
            </div>
          </div>
          <button class="job-action-button" data-audit-action="view-md" data-audit-id="${escapeAttr(item.auditId)}">
            <i data-lucide="eye"></i><span>查看完整 Markdown</span>
          </button>
        </article>
      `).join("");
    }

    const selected = exports.find((item) => item.auditId === state.selectedAuditId);
    getElement("#auditSelectedMeta").textContent = selected
      ? `${selected.auditId}\n${selected.auditDir}\n${selected.chatCount} chats · ${selected.messageCount} messages`
      : "选择一条审计记录查看完整 Markdown。";
    getElement("#auditMarkdownViewer").textContent = state.auditMarkdown || "未打开审计 Markdown。";
    renderIcons();
  }

  window.LocalAiAuditRenderer = { render };
})();
