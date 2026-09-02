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
      renderJobList($("#jobList"), jobs.filter((job) => job.type === "download"), "暂无下载任务", 6);
      renderJobList($("#serviceJobList"), jobs.filter((job) => job.type === "serve"), "暂无启动任务", 4);
      renderJobList($("#benchmarkJobList"), jobs.filter((job) => job.type === "benchmark" || job.type === "automation"), "暂无测速任务", 5);
    }

    function renderJobList(root, jobs, emptyText, maxItems) {
      if (!root) return;
      const visibleJobs = Number(maxItems) > 0 ? jobs.slice(0, maxItems) : jobs;
      const hiddenCount = Math.max(0, jobs.length - visibleJobs.length);
      const footer = hiddenCount
        ? `<div class="job-list-footer">还有 ${hiddenCount} 个历史任务未展示，刷新后仍会保留在后台任务列表中。</div>`
        : "";
      const html = !jobs.length
        ? `<div class="empty">${escapeHtml(emptyText)}</div>`
        : visibleJobs.map((job) => renderJobRow(job)).join("") + footer;
      if (root.__jobsHtml === html) return;
      root.__jobsHtml = html;
      root.innerHTML = html;
    }

    function renderJobRow(job) {
      const status = jobStatusInfo(job.status);
      const priority = job.type === "download" ? String(job.meta?.priority || "normal") : "";
      const priorityLabel = priority === "high" ? "高优先级" : priority === "low" ? "低优先级" : priority ? "普通优先级" : "";
      const retryCount = Number(job.meta?.retryCount || 0);
      const maxRetries = Number(job.meta?.maxRetries || 0);
      const retryLabel = job.type === "download" && maxRetries > 0
        ? `自动重试 ${retryCount}/${maxRetries}${job.meta?.retryScheduledAt ? ` · 计划 ${formatDateTime(job.meta.retryScheduledAt)}` : ""}`
        : "";
      const tail = compactLogText((job.logs || []).slice(-3).join(" | "), 420);
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
              ${priorityLabel ? `<span>${escapeHtml(priorityLabel)}</span>` : ""}
              ${retryLabel ? `<span>${escapeHtml(retryLabel)}</span>` : ""}
              ${job.error ? `<span class="job-error-text">${escapeHtml(job.error)}</span>` : ""}
            </div>
            <p class="job-log-tail" data-no-i18n>${escapeHtml(tail || status.detail)}</p>
            ${renderJobProgress(job)}
            ${expanded ? `<pre class="job-log-full" data-no-i18n>${escapeHtml(compactLogText((job.logs || []).join("\n") || "暂无日志", 30000, true))}</pre>` : ""}
          </div>
        </article>
      `;
    }

    function compactLogText(value, maxChars, keepLineBreaks = false) {
      const normalized = keepLineBreaks
        ? String(value || "").replace(/\r/g, "").replace(/[\t ]+/g, " ")
        : String(value || "").replace(/\s+/g, " ").trim();
      if (normalized.length <= maxChars) return normalized;
      return `...${normalized.slice(normalized.length - maxChars + 3)}`;
    }

    // 服务器每 10 秒扫一次目录，瞬时速度会跳；显示层做指数平滑，ETA 也随之稳定。
    const downloadSpeedEma = new Map();

    function smoothedDownloadSpeed(job, progress) {
      const raw = Number(progress.speedBytesPerSec || 0);
      if (job.status !== "running") {
        downloadSpeedEma.delete(job.id);
        return raw;
      }
      const prev = downloadSpeedEma.get(job.id);
      const ema = prev === undefined ? raw : prev * 0.6 + raw * 0.4;
      downloadSpeedEma.set(job.id, ema);
      return ema;
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
      // 已定稿（正式文件）与传输中（.incomplete）分两段显示：
      // 实心段是校验后会保留的部分，浅色延伸段是仍在写入的分片。
      const finalizedBytes = Number(progress.finalizedBytes);
      const partialBytes = Number(progress.partialBytes || 0);
      const hasSplit = !isDone && percent !== null && Number.isFinite(finalizedBytes) && partialBytes > 0 && totalBytes > 0;
      const finalizedPercent = hasSplit
        ? Math.min(percent, Math.max(0, (finalizedBytes / totalBytes) * 100))
        : null;
      const fillStyle = percent === null ? "" : `style="width:${hasSplit ? finalizedPercent : percent}%"`;
      const fillClass = percent === null && job.status === "running" ? "indeterminate" : "";
      const partialLayer = hasSplit
        ? `<div class="download-progress-fill partial-layer" style="width:${percent}%"></div>`
        : "";
      const mainText = totalBytes
        ? `${fmtBytes(downloadedBytes)} / ${fmtBytes(totalBytes)} · ${percent.toFixed(1)}%`
        : downloadedBytes
          ? `${fmtBytes(downloadedBytes)} 已下载`
          : "等待下载开始";
      const speedValue = smoothedDownloadSpeed(job, progress);
      const speed = speedValue > 0 && job.status === "running" ? `${fmtBytes(speedValue)}/s` : "";
      const etaSeconds = totalBytes && speedValue > 0
        ? Math.max(0, totalBytes - downloadedBytes) / speedValue
        : Number(progress.etaSeconds || 0);
      const eta = etaSeconds > 0 && job.status === "running" ? `剩余约 ${formatDuration(etaSeconds)}` : "";
      const splitText = hasSplit
        ? `已定稿 ${fmtBytes(finalizedBytes)} · 传输中 ${fmtBytes(partialBytes)}`
        : "";
      const detail = [speed, eta, splitText, progress.error].filter(Boolean).join(" · ");

      return `
        <div class="job-progress">
          <div class="download-progress-track">
            ${partialLayer}
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
