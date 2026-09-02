(function () {
  function create(deps = {}) {
    const {
      $ = (selector) => document.querySelector(selector),
      api,
      escapeHtml = defaultEscape,
      escapeAttr = defaultEscape,
      fmtTokens = (value) => String(value || 0),
      fmtMs = (value) => `${Number(value || 0).toFixed(0)} ms`,
      formatDateTime = (value) => String(value || ""),
      renderIcons = () => {},
      notify = () => {},
      reportError = (_title, error) => console.error(error),
      getLanguage = () => "zh-CN",
    } = deps;

    let lastResult = null;

    function labels() {
      return getLanguage() === "en-US" ? {
        loading: "Searching access logs...",
        empty: "No matching access records.",
        result: (returned, total) => `${returned} shown / ${total} matched`,
        searched: "Access log search complete",
        exported: "Access log exported",
        exportFailed: "Access log export failed",
      } : {
        loading: "正在检索访问日志...",
        empty: "没有符合条件的访问记录。",
        result: (returned, total) => `显示 ${returned} 条 / 匹配 ${total} 条`,
        searched: "访问日志检索完成",
        exported: "访问日志已导出",
        exportFailed: "访问日志导出失败",
      };
    }

    function queryParams(extra = {}) {
      const form = $("#accessLogSearchForm");
      const formData = form ? new FormData(form) : new FormData();
      const params = new URLSearchParams();
      for (const [key, value] of formData.entries()) {
        const text = String(value || "").trim();
        if (text) params.set(key, text);
      }
      params.set("limit", String(extra.limit || 300));
      Object.entries(extra).forEach(([key, value]) => {
        if (key !== "limit" && value !== undefined && value !== "") params.set(key, String(value));
      });
      return params;
    }

    async function search(options = {}) {
      const root = $("#accessLogResults");
      if (root) root.innerHTML = `<div class="empty compact">${escapeHtml(labels().loading)}</div>`;
      try {
        lastResult = await api(`/api/access-logs/search?${queryParams(options).toString()}`);
        render();
        if (!options.silent) notify(labels().searched, labels().result(lastResult.returned || 0, lastResult.total || 0), "success");
        return lastResult;
      } catch (error) {
        if (root) root.innerHTML = `<div class="empty compact error-text">${escapeHtml(error.message)}</div>`;
        reportError(labels().searched, error);
        throw error;
      }
    }

    function render() {
      const root = $("#accessLogResults");
      const meta = $("#accessLogResultMeta");
      if (!root || !lastResult) return;
      const events = Array.isArray(lastResult.events) ? lastResult.events : [];
      if (meta) meta.textContent = labels().result(lastResult.returned || events.length, lastResult.total || events.length);
      if (!events.length) {
        root.innerHTML = `<div class="empty compact">${escapeHtml(labels().empty)}</div>`;
        return;
      }
      root.innerHTML = events.map((event) => {
        const stateName = Number(event.status) >= 500 ? "fail" : Number(event.status) >= 400 ? "warn" : "ok";
        const model = event.model && event.resolvedModel && event.model !== event.resolvedModel
          ? `${event.model} -> ${event.resolvedModel}`
          : event.model || event.resolvedModel || "-";
        const queue = Number(event.queuedMs || 0);
        return `
          <div class="access-log-row">
            <span class="status-pill ${stateName}">${escapeHtml(event.status || "-")}</span>
            <div class="access-log-request">
              <strong>${escapeHtml(`${event.method || "-"} ${event.path || "-"}`)}</strong>
              <span>${escapeHtml(event.at ? formatDateTime(event.at) : "-")} · ${escapeHtml(event.remoteAddress || "-")} · ${escapeHtml(event.sourceProgram || event.kind || "-")}</span>
              ${event.error ? `<small class="error-text">${escapeHtml(event.error)}</small>` : ""}
            </div>
            <div class="access-log-meta">
              <strong>${escapeHtml(model)}</strong>
              <span>${fmtMs(event.durationMs || 0)}${queue ? ` · queue ${fmtMs(queue)}` : ""} · ${fmtTokens(event.totalTokens || 0)} tok</span>
            </div>
          </div>
        `;
      }).join("");
      renderIcons();
    }

    async function exportLogs(format) {
      const params = queryParams({ format, maxLines: 100000 });
      try {
        const response = await fetch(`/api/access-logs/export?${params.toString()}`);
        if (!response.ok) throw new Error(await response.text() || response.statusText);
        const blob = await response.blob();
        const disposition = response.headers.get("content-disposition") || "";
        const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `access-logs.${format}`;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notify(labels().exported, filename, "success");
      } catch (error) {
        reportError(labels().exportFailed, error);
      }
    }

    function bind() {
      $("#accessLogSearchForm")?.addEventListener("submit", (event) => {
        event.preventDefault();
        search().catch(() => {});
      });
      $("#resetAccessLogSearchBtn")?.addEventListener("click", () => {
        $("#accessLogSearchForm")?.reset();
        search({ silent: true }).catch(() => {});
      });
      $("#exportAccessLogCsvBtn")?.addEventListener("click", () => exportLogs("csv"));
      $("#exportAccessLogJsonlBtn")?.addEventListener("click", () => exportLogs("jsonl"));
    }

    return { bind, search, render, exportLogs };
  }

  const defaultEscape = (value) => window.LocalAiDomUtils.escapeHtml(value);

  window.LocalAiAccessLogBrowser = { create };
}());
