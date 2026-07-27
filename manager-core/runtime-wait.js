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
    probeRuntime,
    readyProbeTimeoutMs = 5 * 60 * 1000,
    probeRetryIntervalMs = 15 * 1000,
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
  let apiReadyAt = 0;
  let lastProbeAt = 0;
  let lastProbeError = "";

  const finishReady = (served, probe = null, suffix = "") => {
    appendLog(job, `Ready${suffix}.`);
    setJobProgress(job, {
      percent: 100,
      stage: "服务已就绪",
      detail: probe?.detail || `已加载模型：${served.map((item) => item.id).join(", ")}`,
      state: "ok",
    });
    finishJob(job, { servedModels: served, readinessProbe: probe || null });
  };

  const runReadyProbe = async (served) => {
    if (typeof probeRuntime !== "function") {
      finishReady(served, null);
      return true;
    }
    const now = nowFn();
    if (!apiReadyAt) apiReadyAt = now;
    if (lastProbeAt && now - lastProbeAt < probeRetryIntervalMs) return false;
    lastProbeAt = now;
    setJobProgress(job, {
      percent: 96,
      stage: "生成自检",
      detail: `${apiLabel} 已可访问，正在执行最小生成请求，确认输出不是空白、乱码或重复符号。`,
    });
    let probe;
    try {
      probe = await probeRuntime({ servedModels: served, port, apiKey });
    } catch (error) {
      probe = { ok: false, detail: error.message };
    }
    if (probe?.ok) {
      appendLog(job, `Generation readiness probe passed: ${probe.detail || "non-empty output"}`);
      finishReady(served, probe);
      return true;
    }
    lastProbeError = probe?.detail || probe?.error || "生成自检未通过";
    appendLog(job, `Generation readiness probe failed; will retry: ${lastProbeError}`);
    recordRuntimeDiagnostics(job, { issues: [lastProbeError] });
    setJobProgress(job, {
      percent: 96,
      stage: "生成自检未通过",
      detail: lastProbeError,
      state: "warn",
      issues: [lastProbeError],
    });
    if (nowFn() - apiReadyAt >= readyProbeTimeoutMs) {
      setJobProgress(job, {
        percent: 96,
        stage: "生成自检失败",
        detail: lastProbeError,
        state: "fail",
        issues: [lastProbeError],
      });
      throw new Error(`${engineName} API became reachable but generation probe failed: ${lastProbeError}`);
    }
    return false;
  };

  while (nowFn() - started < startupTimeoutMs) {
    if (job?.meta?.cancelRequested || !["running", "queued", undefined].includes(job?.status)) {
      const error = new Error(`${engineName} start cancelled`);
      error.code = "START_CANCELLED";
      throw error;
    }
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
      if (await runReadyProbe(served)) return;
    }

    const container = await getContainerStatus(containerName);
    if (!container.exists) {
      if (container.error) {
        // docker ps 本身失败（daemon 瞬时不可用等），不能判定容器已消失：
        // 容器可能仍在运行，只是状态查询受阻。记录告警后继续轮询，由全局超时兜底。
        appendLog(job, `容器状态查询失败，将重试：${container.error}`);
        setJobProgress(job, {
          percent: job.progress?.percent,
          stage: "容器状态查询失败",
          detail: `${container.error}（Docker daemon 可能瞬时不可用，继续等待。）`,
          state: "warn",
          issues: [container.error],
        });
        await delayFn(pollIntervalMs);
        continue;
      }
      const preservedIssues = job?.meta?.runtimeDiagnostics?.lastIssue
        ? [job.meta.runtimeDiagnostics.lastIssue]
        : [`No such container: ${containerName}`];
      recordRuntimeDiagnostics(job, {
        containerStatus: "missing",
        issues: preservedIssues,
      });
      setJobProgress(job, {
        percent: job.progress?.percent,
        stage: "容器已消失",
        detail: job?.meta?.runtimeDiagnostics?.lastIssue || `${containerName} 不存在，${engineName} 启动进程已经结束或被移除。`,
        state: "fail",
        issues: preservedIssues,
      });
      throw new Error(`${containerName} disappeared before ${engineName} became ready`);
    }

    if (!container.running) {
      await delayFn(1000);
      const logs = await docker(["logs", "--tail", "260", containerName], { rejectOnError: false });
      const logText = `${logs.stdout}${logs.stderr}`;
      const deltaText = logSnapshotDelta(lastLogSnapshot, logText);
      if (deltaText) appendLog(job, deltaText);
      lastLogSnapshot = logText;
      const issues = extractLogIssues(logText);
      recordRuntimeDiagnostics(job, { logText, issues, containerStatus: container.status || "stopped" });
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
      const changed = logText !== lastLogSnapshot;
      if (stallTimeoutMs > 0 && changed) {
        lastLogChangeAt = nowFn();
      }
      const deltaText = logSnapshotDelta(lastLogSnapshot, logText);
      lastLogSnapshot = logText;
      if (deltaText) appendLog(job, deltaText);
      const issues = extractLogIssues(logText);
      recordRuntimeDiagnostics(job, { logText, issues, containerStatus: container.status || "running" });
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
      if (typeof probeRuntime !== "function") {
        finishReady(servedAfterTimeout, null, " after final timeout check");
        return;
      }
      if (await runReadyProbe(servedAfterTimeout)) return;
    }
  }

  const logs = await docker(["logs", "--tail", "180", containerName], { rejectOnError: false });
  const logText = `${logs.stdout}${logs.stderr}`;
  const deltaText = logSnapshotDelta(lastLogSnapshot, logText);
  if (deltaText) appendLog(job, deltaText);
  const issues = extractLogIssues(logText);
  recordRuntimeDiagnostics(job, { logText, issues, containerStatus: "startup-timeout" });
  if (issues.length) {
    setJobProgress(job, {
      percent: 96,
      stage: "启动超时，日志有错误",
      detail: issues[issues.length - 1],
      state: "fail",
      issues,
    });
  }
  if (lastProbeError) {
    throw new Error(`${engineName} API became reachable but generation probe did not pass: ${lastProbeError}`);
  }
  throw new Error(`${engineName} did not become ready within ${Math.round(startupTimeoutMs / 60000)} minutes`);
}

function logSnapshotDelta(previous, current) {
  const before = String(previous || "").replace(/\r\n/g, "\n");
  const after = String(current || "").replace(/\r\n/g, "\n");
  if (!after || after === before) return "";
  if (!before) return after;
  if (after.startsWith(before)) return after.slice(before.length);
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const maxOverlap = Math.min(beforeLines.length, afterLines.length);
  for (let count = maxOverlap; count > 0; count -= 1) {
    const left = beforeLines.slice(-count).join("\n");
    const right = afterLines.slice(0, count).join("\n");
    if (left === right) return afterLines.slice(count).join("\n");
  }
  return after;
}

function recordRuntimeDiagnostics(job, input = {}) {
  if (!job || typeof job !== "object") return;
  const issues = (input.issues || []).filter(Boolean);
  const previous = job.meta?.runtimeDiagnostics || {};
  const logTail = input.logText
    ? String(input.logText).split(/\r?\n/).filter(Boolean).slice(-40).join("\n")
    : previous.lastLogTail || "";
  job.meta = {
    ...(job.meta || {}),
    runtimeDiagnostics: {
      ...previous,
      firstIssue: previous.firstIssue || issues[0] || "",
      lastIssue: issues.at(-1) || previous.lastIssue || "",
      lastContainerStatus: input.containerStatus || previous.lastContainerStatus || "",
      lastLogTail: logTail,
      updatedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  waitForRuntimeReady,
  formatElapsedZh,
  logSnapshotDelta,
  recordRuntimeDiagnostics,
};
