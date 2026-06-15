(function () {
  function create(deps = {}) {
    const {
      $,
      state,
      escapeHtml,
      escapeAttr,
      fmtBytes,
      formatDuration,
      formatDateTime = () => "",
      jobStatusInfo,
      jobTypeLabel = (type) => type || "任务",
      renderServeProgress,
      renderBenchmarkProgress,
      renderAutomationJobProgress,
      showMeta = false,
      showLogActions = false,
      showVerifyActions = false,
    } = deps;

    function renderJobs() {
      const jobs = state.jobs || [];
      renderJobList($("#jobList"), jobs.filter((job) => job.type === "download").slice(0, 6), "暂无下载任务");
      renderJobList($("#serviceJobList"), jobs.filter((job) => job.type === "serve").slice(0, 4), "暂无启动任务");
      renderJobList($("#benchmarkJobList"), jobs.filter((job) => job.type === "benchmark" || job.type === "automation").slice(0, 5), "暂无测速任务");
    }

    function renderJobList(root, jobs, emptyText) {
      if (!root) return;
      const html = !jobs.length
        ? `<div class="empty">${escapeHtml(emptyText)}</div>`
        : jobs.map((job) => renderJobRow(job)).join("");
      if (root.__jobsHtml === html) return;
      root.__jobsHtml = html;
      root.innerHTML = html;
    }

    function renderJobRow(job) {
      const status = jobStatusInfo(job.status);
      const tail = (job.logs || []).slice(-3).join(" | ");
      const expanded = Boolean(showLogActions && state.expandedJobLogs?.has(job.id));
      const updatedAt = job.updatedAt || job.finishedAt || job.createdAt;
      if (!showMeta) {
        return `
          <article class="job-row ${status.rowClass}">
            <div>
              <h4>${escapeHtml(job.title)}</h4>
              <p>${escapeHtml(tail || status.detail || job.type)}</p>
              ${renderJobProgress(job)}
            </div>
            <span class="pill ${status.pillClass}">${escapeHtml(status.label)}</span>
          </article>
        `;
      }
      return `
        <article class="job-row ${status.rowClass}">
          <div>
            <div class="job-title-line">
              <h4>${escapeHtml(job.title)}</h4>
              <span class="pill ${status.pillClass}">${escapeHtml(status.label)}</span>
            </div>
            <div class="job-meta-line">
              <span>${escapeHtml(jobTypeLabel(job.type))}</span>
              <span>${escapeHtml(formatDateTime(updatedAt))}</span>
              ${job.error ? `<span class="job-error-text">${escapeHtml(job.error)}</span>` : ""}
            </div>
            <p class="job-log-tail">${escapeHtml(tail || status.detail)}</p>
            ${renderJobProgress(job)}
            ${expanded ? `<pre class="job-log-full">${escapeHtml((job.logs || []).join("\n") || "暂无日志")}</pre>` : ""}
          </div>
        </article>
      `;
    }

    function renderJobProgress(job) {
      if (job.type === "serve") return renderServeProgress(job);
      if (job.type === "benchmark") return renderBenchmarkProgress(job);
      if (job.type === "automation") return renderAutomationJobProgress(job);
      if (job.type !== "download") return "";
      const progress = job.progress || {};
      const totalBytes = Number(progress.totalBytes || job.meta?.expectedBytes || 0);
      const downloadedBytes = Number(progress.downloadedBytes || 0);
      const isDone = job.status === "success";
      const percent = totalBytes
        ? Math.min(100, Math.max(0, Number(progress.percent ?? (downloadedBytes / totalBytes) * 100)))
        : (isDone ? 100 : null);
      const fillStyle = percent === null ? "" : `style="width:${percent}%"`;
      const fillClass = percent === null && job.status === "running" ? "indeterminate" : "";
      const mainText = totalBytes
        ? `${fmtBytes(downloadedBytes)} / ${fmtBytes(totalBytes)} · ${percent.toFixed(1)}%`
        : downloadedBytes
          ? `${fmtBytes(downloadedBytes)} 已下载`
          : "等待下载开始";
      const speed = progress.speedBytesPerSec > 0 ? `${fmtBytes(progress.speedBytesPerSec)}/s` : "";
      const eta = progress.etaSeconds > 0 && job.status === "running" ? `剩余约 ${formatDuration(progress.etaSeconds)}` : "";
      const detail = [speed, eta, progress.error].filter(Boolean).join(" · ");

      return `
        <div class="job-progress">
          <div class="download-progress-track">
            <div class="download-progress-fill ${fillClass}" ${fillStyle}></div>
          </div>
          <div class="download-progress-meta">
            <span>${escapeHtml(mainText)}</span>
            <small>${escapeHtml(detail || (totalBytes ? "按本地目录大小估算" : "无法读取总大小时显示已落盘大小"))}</small>
          </div>
          ${renderDownloadActions(job)}
        </div>
      `;
    }

    function renderDownloadActions(job) {
      const meta = job.meta || {};
      const logsButton = showLogActions
        ? `<button type="button" class="job-action-button" data-download-action="logs" data-job="${escapeAttr(job.id)}">${state.expandedJobLogs?.has(job.id) ? "收起日志" : "查看日志"}</button>`
        : "";
      if (job.status === "running") {
        return `
          <div class="job-actions">
            <button type="button" class="job-action-button" data-download-action="pause" data-job="${escapeAttr(job.id)}">暂停</button>
            <button type="button" class="job-action-button danger" data-download-action="cancel" data-job="${escapeAttr(job.id)}">取消并删除</button>
            ${logsButton}
          </div>
        `;
      }
      if (job.status === "queued" && showLogActions) {
        return `
          <div class="job-actions">
            <button type="button" class="job-action-button" data-download-action="pause" data-job="${escapeAttr(job.id)}">暂停排队</button>
            <button type="button" class="job-action-button danger" data-download-action="cancel" data-job="${escapeAttr(job.id)}">取消并删除</button>
            ${logsButton}
          </div>
        `;
      }
      const canResume = meta.model && ["paused", "interrupted", "failed", "cancelled"].includes(job.status);
      const resumeButton = canResume
        ? `<button type="button" class="job-action-button primary" data-download-action="resume" data-job="${escapeAttr(job.id)}">继续下载</button>`
        : "";
      const cleanupButton = meta.localDir && ["paused", "interrupted", "failed"].includes(job.status)
        ? `<button type="button" class="job-action-button danger" data-download-action="cancel" data-job="${escapeAttr(job.id)}">取消并删除</button>`
        : "";
      const verifyButton = showVerifyActions && (meta.localDir || meta.outputName)
        ? `<button type="button" class="job-action-button" data-download-action="verify" data-job="${escapeAttr(job.id)}">校验文件</button>`
        : "";
      const startButton = showVerifyActions && job.status === "success" && (meta.localDir || meta.outputName)
        ? `<button type="button" class="job-action-button primary" data-download-action="use-start" data-job="${escapeAttr(job.id)}">填入启动</button>`
        : "";
      const actions = [resumeButton, cleanupButton, verifyButton, startButton, logsButton].filter(Boolean).join("");
      return actions ? `<div class="job-actions">${actions}</div>` : "";
    }

    return {
      renderJobs,
    };
  }

  window.LocalAiJobRenderer = { create };
})();
