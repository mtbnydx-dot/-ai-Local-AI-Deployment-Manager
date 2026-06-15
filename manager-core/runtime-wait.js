function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatElapsedZh(ms) {
  return `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;
}

async function waitForRuntimeReady(options = {}) {
  const {
    job,
    port,
    apiKey,
    serviceUrl,
    waitUrl = `http://127.0.0.1:${port}/v1/models`,
    engineName,
    apiLabel = `${engineName} API`,
    containerName,
    startupTimeoutMs,
    stallTimeoutMs = 0,
    pollIntervalMs = 5000,
    logPollIntervalMs = 10000,
    fetchServedModels,
    getContainerStatus,
    docker,
    extractLogIssues,
    setJobProgress,
    appendLog,
    finishJob,
    delayFn = delay,
    nowFn = Date.now,
    timeoutBudgetLog = "",
    finalReadyCheck = false,
    noLogIssue = `${engineName} 启动日志长时间无变化。`,
    pollDetail,
  } = options;

  appendLog(job, `Service URL: ${serviceUrl}`);
  appendLog(job, `Waiting for ${waitUrl}`);
  if (timeoutBudgetLog) appendLog(job, timeoutBudgetLog);

  const started = nowFn();
  let lastLogCheck = 0;
  let lastLogSnapshot = "";
  let lastLogChangeAt = nowFn();

  while (nowFn() - started < startupTimeoutMs) {
    const elapsed = nowFn() - started;
    setJobProgress(job, {
      percent: Math.min(94, 45 + (elapsed / startupTimeoutMs) * 49),
      stage: "等待模型加载",
      detail: pollDetail
        ? pollDetail({ elapsed, formatElapsed: formatElapsedZh, apiLabel })
        : `正在轮询 ${apiLabel}，并读取容器日志检查错误。`,
    });

    const served = await fetchServedModels({ port, apiKey });
    if (served.length) {
      appendLog(job, "Ready.");
      setJobProgress(job, {
        percent: 100,
        stage: "服务已就绪",
        detail: `已加载模型：${served.map((item) => item.id).join(", ")}`,
        state: "ok",
      });
      finishJob(job, { servedModels: served });
      return;
    }

    const container = await getContainerStatus(containerName);
    if (!container.exists) {
      setJobProgress(job, {
        percent: job.progress?.percent,
        stage: "容器已消失",
        detail: `${containerName} 不存在，${engineName} 启动进程已经结束或被移除。`,
        state: "fail",
        issues: [`No such container: ${containerName}`],
      });
      throw new Error(`${containerName} disappeared before ${engineName} became ready`);
    }

    if (!container.running) {
      await delayFn(1000);
      const logs = await docker(["logs", "--tail", "260", containerName], { rejectOnError: false });
      const logText = `${logs.stdout}${logs.stderr}`;
      appendLog(job, logText);
      const issues = extractLogIssues(logText);
      setJobProgress(job, {
        percent: job.progress?.percent,
        stage: "容器已退出",
        detail: issues[issues.length - 1] || container.status || `${engineName} 容器已停止。`,
        state: "fail",
        issues: issues.length ? issues : [container.status || "Container exited"],
      });
      throw new Error(`${engineName} container exited before becoming ready: ${container.status || "stopped"}`);
    }

    if (nowFn() - lastLogCheck > logPollIntervalMs) {
      lastLogCheck = nowFn();
      const logs = await docker(["logs", "--tail", "30", containerName], { rejectOnError: false });
      const logText = `${logs.stdout}${logs.stderr}`;
      if (stallTimeoutMs > 0 && logText !== lastLogSnapshot) {
        lastLogSnapshot = logText;
        lastLogChangeAt = nowFn();
      }
      appendLog(job, logText);
      const issues = extractLogIssues(logText);
      if (issues.length) {
        setJobProgress(job, {
          percent: job.progress?.percent,
          stage: "日志发现错误",
          detail: issues[issues.length - 1],
          state: "warn",
          issues,
        });
      }
      if (stallTimeoutMs > 0 && nowFn() - lastLogChangeAt > stallTimeoutMs) {
        setJobProgress(job, {
          percent: job.progress?.percent,
          stage: "启动停滞",
          detail: `容器日志已 ${formatElapsedZh(nowFn() - lastLogChangeAt)} 没有任何变化，判定启动卡死。`,
          state: "fail",
          issues: issues.length ? issues : [noLogIssue],
        });
        throw new Error(`${engineName} start stalled: no log output for ${Math.round(stallTimeoutMs / 60000)} minutes`);
      }
    }

    await delayFn(pollIntervalMs);
  }

  if (finalReadyCheck) {
    const servedAfterTimeout = await fetchServedModels({ port, apiKey });
    if (servedAfterTimeout.length) {
      appendLog(job, "Ready after final timeout check.");
      setJobProgress(job, {
        percent: 100,
        stage: "服务已就绪",
        detail: `已加载模型：${servedAfterTimeout.map((item) => item.id).join(", ")}`,
        state: "ok",
      });
      finishJob(job, { servedModels: servedAfterTimeout });
      return;
    }
  }

  const logs = await docker(["logs", "--tail", "180", containerName], { rejectOnError: false });
  const logText = `${logs.stdout}${logs.stderr}`;
  appendLog(job, logText);
  const issues = extractLogIssues(logText);
  if (issues.length) {
    setJobProgress(job, {
      percent: 96,
      stage: "启动超时，日志有错误",
      detail: issues[issues.length - 1],
      state: "fail",
      issues,
    });
  }
  throw new Error(`${engineName} did not become ready within ${Math.round(startupTimeoutMs / 60000)} minutes`);
}

module.exports = {
  waitForRuntimeReady,
  formatElapsedZh,
};
