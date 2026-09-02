(function () {
  function create(deps = {}) {
    const {
      $ = (selector) => document.querySelector(selector),
      api,
      escapeHtml = defaultEscape,
      escapeAttr = defaultEscape,
      formatDateTime = (value) => String(value || ""),
      renderIcons = () => {},
      notify = () => {},
      reportError = (_title, error) => console.error(error),
      getLanguage = () => "zh-CN",
    } = deps;

    let data = { backups: [] };

    function labels() {
      return getLanguage() === "en-US" ? {
        empty: "No manager configuration backups yet.",
        valid: "Verified",
        invalid: "Checksum failed",
        entries: "settings groups",
        download: "Download backup",
        restore: "Restore this backup",
        created: "Manager backup created",
        restored: "Manager settings restored",
        restoreConfirm: "Restore this manager configuration backup? Running model containers will not be changed. The manager must be restarted to reload restored settings.",
        loadFailed: "Failed to load manager backups",
        createFailed: "Failed to create manager backup",
        restoreFailed: "Failed to restore manager backup",
      } : {
        empty: "暂无管理器配置备份。",
        valid: "校验通过",
        invalid: "校验失败",
        entries: "组设置",
        download: "下载备份",
        restore: "恢复此备份",
        created: "管理器配置备份已创建",
        restored: "管理器配置已恢复",
        restoreConfirm: "确认恢复这个管理器配置备份？运行中的模型容器不会改变；恢复后需要重启管理器进程以重新载入设置。",
        loadFailed: "管理器备份读取失败",
        createFailed: "管理器备份创建失败",
        restoreFailed: "管理器备份恢复失败",
      };
    }

    async function refresh(options = {}) {
      try {
        data = await api("/api/backups");
        render();
        return data;
      } catch (error) {
        const root = $("#managerBackupList");
        if (root) root.innerHTML = `<div class="empty compact error-text">${escapeHtml(error.message)}</div>`;
        if (!options.silent) reportError(labels().loadFailed, error);
        throw error;
      }
    }

    function render() {
      const root = $("#managerBackupList");
      if (!root) return;
      const backups = Array.isArray(data.backups) ? data.backups : [];
      if (!backups.length) {
        root.innerHTML = `<div class="empty compact">${escapeHtml(labels().empty)}</div>`;
        return;
      }
      root.innerHTML = backups.map((backup) => `
        <article class="manager-backup-row">
          <div>
            <div class="manager-backup-title">
              <strong>${escapeHtml(formatDateTime(backup.createdAt))}</strong>
              <span class="status-pill ${backup.valid ? "ok" : "fail"}">${escapeHtml(backup.valid ? labels().valid : labels().invalid)}</span>
            </div>
            <p>${escapeHtml(`${backup.entryCount || 0} ${labels().entries}`)} · SHA256 ${escapeHtml(String(backup.sha256 || "").slice(0, 16))}...</p>
          </div>
          <div class="mini-actions">
            <a class="icon-link-button" href="/api/backups/${encodeURIComponent(backup.id)}/download" title="${escapeAttr(labels().download)}"><i data-lucide="download"></i></a>
            <button type="button" title="${escapeAttr(labels().restore)}" data-backup-action="restore" data-backup-id="${escapeAttr(backup.id)}" ${backup.valid ? "" : "disabled"}><i data-lucide="rotate-ccw"></i></button>
          </div>
        </article>
      `).join("");
      renderIcons();
    }

    async function createBackup(event) {
      const button = event?.currentTarget;
      if (button) button.disabled = true;
      try {
        const result = await api("/api/backups", { method: "POST", body: "{}" });
        notify(labels().created, result.backup?.id || "", "success");
        await refresh({ silent: true });
      } catch (error) {
        reportError(labels().createFailed, error);
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function handleClick(event) {
      const button = event.target.closest("[data-backup-action='restore']");
      if (!button || !window.confirm(labels().restoreConfirm)) return;
      button.disabled = true;
      try {
        const result = await api(`/api/backups/${encodeURIComponent(button.dataset.backupId || "")}/restore`, { method: "POST", body: "{}" });
        notify(labels().restored, (result.restored || []).join(", "), "success");
        await refresh({ silent: true });
      } catch (error) {
        reportError(labels().restoreFailed, error);
      } finally {
        button.disabled = false;
      }
    }

    function bind() {
      $("#createManagerBackupBtn")?.addEventListener("click", createBackup);
      $("#reloadManagerBackupsBtn")?.addEventListener("click", () => refresh().catch(() => {}));
      $("#managerBackupList")?.addEventListener("click", handleClick);
    }

    return { bind, refresh, render };
  }

  const defaultEscape = (value) => window.LocalAiDomUtils.escapeHtml(value);

  window.LocalAiManagerBackups = { create };
}());
