(function () {
  function create(deps = {}) {
    const {
      $,
      state,
      statsMetric,
      fmtTokens,
      fmtRate,
      fmtPct,
      fmtSeconds,
      formatDuration,
      formatContextUsage,
      options = {},
    } = deps;

    const settings = {
      totalTokensLabel: "总 tokens",
      tokenDetailInput: "输入",
      tokenDetailOutput: "输出",
      requestLabel: "请求数",
      successLabel: "成功",
      errorLabel: "错误",
      abortedLabel: "中止",
      liveTokensLabel: "Current run tokens",
      liveRequestsLabel: "Current run requests",
      currentInstanceLabel: "当前实例",
      currentSpeedLabel: "当前输出速度",
      latencyLabel: "平均延迟",
      kvLabel: "活跃 KV cache",
      kvDetail: "只表示当前正在推理的请求；聊天历史在 Open WebUI 侧保存",
      prefixCacheLabel: "Prefix cache 命中",
      speculativeLabel: "推测解码接受率",
      uptimeLabel: "运行时长",
      lifetimeLabel: "生命周期",
      includeRuntimeModels: false,
      includePrefixCache: false,
      includeLiveUsage: false,
      preferLiveRuntimeMetrics: false,
      speculativeLabels: {
        dspark: "DSpark acceptance",
        nextn: "NEXTN/MTP acceptance",
        mtp: "MTP acceptance",
        mixed: "Speculative decoding acceptance",
      },
      heroFirstMetric: false,
      includeRuntimeConfig: false,
      runtimeConfigLabel: "Runtime configuration",
      runtimeThinkingToggleLabel: "thinking toggle",
      runtimeUnitScaleLabel: "scale=1 canary",
      ...options,
    };

    function render(stats) {
      const root = $("#statsSummary");
      if (!root || !stats) return;
      const totals = stats.totals || {};
      const liveTotals = stats.live?.totals || {};
      const runtimeTotals = settings.preferLiveRuntimeMetrics && stats.live ? liveTotals : totals;
      const tokens = totals.tokens || {};
      const requests = totals.requests || {};
      const liveTokens = liveTotals.tokens || {};
      const liveRequests = liveTotals.requests || {};
      const speed = runtimeTotals.speed || {};
      const latency = runtimeTotals.latency || {};
      const context = runtimeTotals.context || {};
      const cache = runtimeTotals.cache || {};
      const speculative = runtimeTotals.speculative || {};
      const runtimeConfig = stats.live?.facts?.runtimeConfig || stats.facts?.runtimeConfig || {};
      const cards = [
        statsMetric(settings.totalTokensLabel, fmtTokens(tokens.total), `${fmtTokens(tokens.prompt)} ${settings.tokenDetailInput} · ${fmtTokens(tokens.generation)} ${settings.tokenDetailOutput}`, settings.heroFirstMetric ? "stats-metric-hero" : ""),
        statsMetric(settings.requestLabel, fmtTokens(requests.total), requestDetail(requests)),
      ];

      if (settings.includeLiveUsage && stats.live) {
        cards.push(
          statsMetric(settings.liveTokensLabel, fmtTokens(liveTokens.total), `${fmtTokens(liveTokens.prompt)} ${settings.tokenDetailInput} · ${fmtTokens(liveTokens.generation)} ${settings.tokenDetailOutput}`),
          statsMetric(settings.liveRequestsLabel, fmtTokens(liveRequests.total), requestDetail(liveRequests)),
        );
      }

      if (settings.includeRuntimeModels) {
        const liveModelCount = stats.live?.models?.length || state.status?.runningModels?.length || 0;
        const historicalModelCount = Math.max(0, (stats.models || []).length - liveModelCount);
        cards.push(statsMetric(settings.currentInstanceLabel, `${fmtTokens(liveModelCount)} 个`, `${fmtTokens(historicalModelCount)} 个历史模型保留累计消耗`));
      }

      cards.push(
        statsMetric(settings.currentSpeedLabel, fmtRate(speed.recentOutputTokensPerSecond, " tok/s"), `${fmtRate(speed.recentPromptTokensPerSecond, " in/s")} · ${fmtRate(speed.recentRequestsPerMinute, " req/min")}${speed.outputSource === "sglang_recent_gauge" ? " · 最近一次活跃采样" : speed.outputSource === "sglang_active_average" ? " · 启动以来活跃平均" : ""}`),
        statsMetric(settings.latencyLabel, fmtSeconds(latency.avgE2eSeconds), `TTFT ${fmtSeconds(latency.avgTtftSeconds)}`),
        statsMetric(settings.kvLabel, formatContextUsage(context.activeTokens, context.capacityTokens, context.kvUsagePercent), settings.kvDetail),
      );

      if (settings.includeRuntimeConfig && Object.values(runtimeConfig).some(Boolean)) {
        const kvDtype = String(runtimeConfig.kvCacheDtype || "").toLowerCase();
        const kvLabel = /^fp8/.test(kvDtype)
          ? "FP8 KV"
          : /^(bf16|bfloat16)$/.test(kvDtype) || kvDtype === "auto" || !kvDtype
            ? "BF16 KV"
            : `${kvDtype.toUpperCase()} KV`;
        const pleDtype = /^fp8/.test(String(runtimeConfig.pleDtype || "").toLowerCase()) ? "FP8 " : "";
        const contextDetail = Number(runtimeConfig.maxTotalTokens || 0) > 0
          ? `${fmtTokens(runtimeConfig.maxTotalTokens)} KV 池${Number(runtimeConfig.contextLength || 0) > 0 ? ` / ${fmtTokens(runtimeConfig.contextLength)} 模型上限` : ""}`
          : "";
        const storageDetail = runtimeConfig.storageMode === "nvme-ple"
          ? `NVMe ${pleDtype}PLE`
          : runtimeConfig.storageMode === "cpu-ple"
            ? `CPU RAM ${pleDtype}PLE`
            : runtimeConfig.storageMode;
        const speculativeDetail = runtimeConfig.speculativeMode === "nextn"
          ? "NEXTN/MTP"
          : runtimeConfig.speculativeMode === "off"
            ? "MTP 关闭"
            : runtimeConfig.speculativeMode;
        const backendDetail = runtimeConfig.fp4Backend === "flashinfer_cutlass" && runtimeConfig.moeBackend === "flashinfer_cutlass"
          ? "Cutlass FP4/MoE"
          : [runtimeConfig.fp4Backend, runtimeConfig.moeBackend].filter(Boolean).join(" + ");
        const details = [
          contextDetail,
          speculativeDetail,
          storageDetail,
          runtimeConfig.cacheMode === "persistent-ext4" ? "ext4 编译缓存" : runtimeConfig.cacheMode,
          backendDetail,
          runtimeConfig.thinkingMode === "strict-toggle" ? settings.runtimeThinkingToggleLabel : runtimeConfig.thinkingMode,
          runtimeConfig.kvScaleMode === "unit" ? settings.runtimeUnitScaleLabel : "",
        ].filter(Boolean);
        cards.push(statsMetric(settings.runtimeConfigLabel, kvLabel, details.join(" · ")));
      }

      if (settings.includePrefixCache) {
        const hasNativePrefixCounters = Number(cache.prefixQueries || 0) > 0;
        const cacheHit = hasNativePrefixCounters
          ? Number(cache.prefixHitRate || 0)
          : tokens.prompt ? Number(tokens.cachedPrompt || 0) / tokens.prompt : 0;
        const hits = hasNativePrefixCounters ? cache.prefixHits : tokens.cachedPrompt;
        const queries = hasNativePrefixCounters ? cache.prefixQueries : tokens.prompt;
        const alignment = cache.alignmentBlockSize
          ? ` · ${cache.alignmentRequired ? "Mamba 对齐" : "block"} ${fmtTokens(cache.alignmentBlockSize)}`
          : "";
        const cacheSource = cache.source === "sglang_latest_batch_gauge" ? " · 最近 prefill 快照" : "";
        cards.push(statsMetric(settings.prefixCacheLabel, fmtPct(cacheHit), `${fmtTokens(hits || 0)} / ${fmtTokens(queries || 0)} 输入 token 命中${alignment}${cacheSource}`));
      }

      if (speculative.enabled) {
        const speculativeLabel = settings.speculativeLabels?.[speculative.mode] || settings.speculativeLabel;
        const speculativeDetail = Number(speculative.meanAcceptLength || 0) > 0
          ? `${Number(speculative.meanAcceptLength).toFixed(2)} 平均接受长度（含 bonus） · ${fmtTokens(speculative.draftCycles || 0)} verify 轮`
          : `${Number(speculative.acceptedTokensPerCycle || 0).toFixed(2)} 接受 token/轮 · ${fmtTokens(speculative.draftCycles || 0)} 轮`;
        cards.push(statsMetric(
          speculativeLabel,
          fmtPct(speculative.acceptanceRate || 0),
          speculativeDetail,
        ));
      }

      const uptimeSeconds = settings.preferLiveRuntimeMetrics && stats.live ? stats.live.uptimeSeconds : stats.uptimeSeconds;
      cards.push(statsMetric(settings.uptimeLabel, uptimeSeconds ? formatDuration(uptimeSeconds) : "-", `${settings.lifetimeLabel} ${fmtRate(speed.lifetimeTokensPerSecond, " tok/s")}`));
      root.innerHTML = cards.join("");
    }

    function requestDetail(requests) {
      if (settings.includeRuntimeModels) {
        return `${fmtTokens(requests.success)} ${settings.successLabel} · ${fmtTokens(requests.error)} ${settings.errorLabel} · ${fmtTokens(requests.aborted)} ${settings.abortedLabel}`;
      }
      return `${fmtTokens(requests.error)} ${settings.errorLabel} · ${fmtTokens(requests.aborted)} ${settings.abortedLabel}`;
    }

    return { render };
  }

  window.LocalAiStatsSummaryRenderer = { create };
})();
