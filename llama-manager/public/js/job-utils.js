(function () {
  function jobStatusInfo(status) {
    if (status === "success") return { label: "完成", pillClass: "ok", rowClass: "is-success", detail: "任务已完成" };
    if (status === "failed") return { label: "失败", pillClass: "fail", rowClass: "is-failed", detail: "任务失败，查看日志尾部或重试" };
    if (status === "cancelled") return { label: "已取消", pillClass: "fail", rowClass: "is-failed", detail: "下载已取消，部分文件已清理" };
    if (status === "paused") return { label: "已暂停", pillClass: "warn", rowClass: "is-queued", detail: "下载已暂停，可以继续" };
    if (status === "interrupted") return { label: "中断", pillClass: "warn", rowClass: "is-queued", detail: "管理器重启时任务仍在运行" };
    if (status === "queued") return { label: "等待", pillClass: "warn", rowClass: "is-queued", detail: "等待后台开始处理" };
    return { label: "运行中", pillClass: "warn", rowClass: "is-running", detail: "后台正在处理" };
  }

  function isDockerDaemonIssue(job) {
    const progress = job?.progress || {};
    const text = [
      job?.error,
      progress.detail,
      ...(progress.issues || []),
      ...(job?.logs || []),
    ].filter(Boolean).join("\n").toLowerCase();
    return text.includes("dockerdesktoplinuxengine")
      || text.includes("docker api")
      || text.includes("daemon is running")
      || text.includes("cannot connect to the docker daemon")
      || text.includes("docker daemon")
      || text.includes("docker desktop");
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds || 0)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) return `${hours}小时${minutes}分`;
    if (minutes) return `${minutes}分${secs}秒`;
    return `${secs}秒`;
  }

  window.LlamaJobUtils = {
    jobStatusInfo,
    isDockerDaemonIssue,
    formatDuration,
  };
})();
