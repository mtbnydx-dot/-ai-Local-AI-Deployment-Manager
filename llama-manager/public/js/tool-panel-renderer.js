(function () {
  function create(deps = {}) {
    const {
      $,
      state,
      escapeHtml,
      escapeAttr,
      fmtNumber,
      fmtTokens,
      formatDateTime,
      miniStat,
      renderIcons,
      onApplyModelCheck,
      options = {},
    } = deps;

    const copy = {
      healthEmpty: "点击检查后显示环境状态。",
      healthWaiting: "等待健康检查",
      healthOk: "环境可用",
      healthWarn: "发现需要处理的问题",
      applyRecommendations: "套用推荐参数",
      logNoIssues: "最近日志没有明显错误。",
      automationOn: "自动保护已配置",
      automationOff: "自动保护关闭",
      idleUnload: "空闲时卸载",
      warnOnly: "只提醒",
      modelNotesEmpty: "暂无收藏标签。",
      useModel: "填入启动",
      delete: "删除",
      showCompressionSessions: false,
      ...options,
    };

    function renderHealth() {
      const report = state.health;
      const scoreBox = $("#healthScoreBox");
      const grid = $("#healthGrid");
      if (!grid) return;
      if (!report) {
        grid.innerHTML = `<div class="empty compact">${escapeHtml(copy.healthEmpty)}</div>`;
        if (scoreBox) scoreBox.textContent = copy.healthWaiting;
        return;
      }
      if (scoreBox) {
        scoreBox.innerHTML = `
          <strong>${fmtNumber(report.score)} 分</strong>
          <span>${report.ok ? copy.healthOk : copy.healthWarn} · ${formatDateTime(report.generatedAt)}</span>
        `;
      }
      grid.innerHTML = (report.checks || []).map((check) => `
        <article class="tool-card tool-${escapeAttr(check.status)}">
          <div>
            <span class="tool-status-dot"></span>
            <strong>${escapeHtml(check.label)}</strong>
          </div>
          <p>${escapeHtml(check.detail || "")}</p>
        </article>
      `).join("");
    }

    function renderModelCheck() {
      const root = $("#modelCheckResult");
      const result = state.modelCheck;
      if (!root || !result) return;
      root.innerHTML = `
        <div class="tool-result-head">
          <strong>${escapeHtml(result.model)}</strong>
          <span class="pill ${result.severity === "fail" ? "fail" : result.severity === "warn" ? "warn" : "ok"}">${escapeHtml(result.severity)}</span>
        </div>
        <div class="tool-list">
          ${(result.findings || []).map((item) => `
            <article class="tool-card tool-${escapeAttr(item.severity)}">
              <div><span class="tool-status-dot"></span><strong>${escapeHtml(item.title)}</strong></div>
              <p>${escapeHtml(item.detail)}</p>
            </article>
          `).join("")}
        </div>
        <div class="job-actions">
          <button class="job-action-button primary" type="button" id="applyModelCheckBtn">${escapeHtml(copy.applyRecommendations)}</button>
        </div>
      `;
      $("#applyModelCheckBtn")?.addEventListener("click", () => {
        if (typeof onApplyModelCheck === "function") onApplyModelCheck(result);
      });
      renderIcons();
    }

    function renderLogSummary() {
      const root = $("#logSummaryPanel");
      const summary = state.logSummary;
      if (!root || !summary) return;
      root.innerHTML = `
        <div class="tool-result-head">
          <strong>${escapeHtml(summary.stage || "未知阶段")}</strong>
          <span class="pill ${summary.ok ? "ok" : "fail"}">${summary.ok ? "正常" : "有错误"}</span>
        </div>
        <div class="tool-list">
          ${(summary.issues || []).map((item) => `
            <article class="tool-card tool-${escapeAttr(item.severity)}">
              <div><span class="tool-status-dot"></span><strong>${escapeHtml(item.message)}</strong></div>
              <p>${escapeHtml(item.hint || "")}</p>
            </article>
          `).join("") || `<div class="empty compact">${escapeHtml(copy.logNoIssues)}</div>`}
        </div>
        <div class="selection-hint">${(summary.suggestions || []).map(escapeHtml).join(" · ")}</div>
      `;
    }

    function renderAutomationSettings() {
      const settings = state.automationSettings || {};
      setChecked("#idleUnloadEnabled", Boolean(settings.idleUnloadEnabled));
      setValue("#idleMinutes", settings.idleMinutes || 30);
      setChecked("#vramGuardEnabled", Boolean(settings.vramGuardEnabled));
      setValue("#vramPercent", settings.vramPercent || 94);
      setValue("#vramAction", settings.vramAction || "warn");
      const status = $("#automationStatus");
      if (status) {
        status.innerHTML = `
          <strong>${settings.idleUnloadEnabled || settings.vramGuardEnabled ? copy.automationOn : copy.automationOff}</strong>
          <span>空闲 ${fmtTokens(settings.idleMinutes || 30)} 分钟 · 显存阈值 ${fmtTokens(settings.vramPercent || 94)}% · ${settings.vramAction === "unload" ? copy.idleUnload : copy.warnOnly}</span>
        `;
      }
    }

    function renderConnectionGuide() {
      const root = $("#connectionGuide");
      const guide = state.connectionGuide;
      if (!root || !guide) return;
      root.innerHTML = `
        <div class="compat-endpoints">
          <div><strong>OpenWebUI / OpenAI Base URL</strong><code>${escapeHtml(guide.openai?.baseUrl || "-")}</code><span>API Key 可填任意占位字符串；模型名：${escapeHtml(guide.model || "-")}</span></div>
          <div><strong>Claude / ccswitch Base URL</strong><code>${escapeHtml(guide.claude?.baseUrl || "-")}</code><span>模型别名：${escapeHtml(guide.claude?.modelAlias || "-")}</span></div>
          <div><strong>curl 测试</strong><code>${escapeHtml(guide.openai?.curl || "-")}</code><span>用于确认本地服务是否返回模型列表。</span></div>
          <div><strong>管理器地址</strong><code>${escapeHtml(guide.manager?.local || "-")}</code><span>${guide.manager?.lan ? `局域网：${escapeHtml(guide.manager.lan)}` : "当前管理器只绑定本机。"}</span></div>
        </div>
      `;
    }

    function renderCompressionInsights() {
      const root = $("#compressionInsights");
      const data = state.compressionInsights;
      if (!root || !data) return;
      const totals = data.totals || {};
      const last = data.last || {};
      const sessions = copy.showCompressionSessions
        ? `<div class="client-session-list">${(data.sessions || []).slice(0, 6).map((item) => `<span>${escapeHtml(item.label || item.id)}：${fmtTokens(item.compression?.savedTokens || 0)} saved</span>`).join("")}</div>`
        : "";
      root.innerHTML = `
        <div class="stats-row-grid">
          ${miniStat("触发次数", fmtTokens(totals.applied || 0), "Claude 桥自动压缩")}
          ${miniStat("节省 tokens", fmtTokens(totals.savedTokens || 0), `最近 ${fmtTokens(last.savedTokens || 0)}`)}
          ${miniStat("最近原文", fmtTokens(last.recentMessageCount || 0), "压缩后保留的最近消息")}
          ${miniStat("摘要消息", fmtTokens(last.summarizedMessageCount || 0), "被压缩进摘要的旧消息")}
        </div>
        ${sessions}
        <div class="selection-hint">${escapeHtml(data.note || "")}</div>
      `;
    }

    function renderModelNotes() {
      const root = $("#modelNotesList");
      if (!root) return;
      const notes = Object.values(state.modelNotes?.notes || {}).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      if (!notes.length) {
        root.innerHTML = `<div class="empty compact">${escapeHtml(copy.modelNotesEmpty)}</div>`;
        return;
      }
      root.innerHTML = notes.map((note) => `
        <article class="profile-card">
          <div>
            <h4>${note.favorite ? "★ " : ""}${escapeHtml(note.model)}</h4>
            <p>${escapeHtml(note.note || "无备注")}</p>
            <div class="pill-row">${(note.tags || []).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}</div>
          </div>
          <div class="job-actions">
            <button class="job-action-button primary" type="button" data-note-action="use" data-model="${escapeAttr(note.model)}">${escapeHtml(copy.useModel)}</button>
            <button class="job-action-button danger" type="button" data-note-action="delete" data-note-key="${escapeAttr(note.key)}">${escapeHtml(copy.delete)}</button>
          </div>
        </article>
      `).join("");
    }

    function setChecked(selector, value) {
      const element = $(selector);
      if (element) element.checked = value;
    }

    function setValue(selector, value) {
      const element = $(selector);
      if (element) element.value = value;
    }

    return {
      renderHealth,
      renderModelCheck,
      renderLogSummary,
      renderAutomationSettings,
      renderConnectionGuide,
      renderCompressionInsights,
      renderModelNotes,
    };
  }

  window.LocalAiToolPanelRenderer = { create };
})();
