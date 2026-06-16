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
      currentInstanceLabel: "当前实例",
      currentSpeedLabel: "当前输出速度",
      latencyLabel: "平均延迟",
      kvLabel: "活跃 KV cache",
      kvDetail: "只表示当前正在推理的请求；聊天历史在 Open WebUI 侧保存",
      prefixCacheLabel: "Prefix cache 命中",
      uptimeLabel: "运行时长",
      lifetimeLabel: "生命周期",
      includeRuntimeModels: false,
      includePrefixCache: false,
      heroFirstMetric: false,
      ...options,
    };

    function render(stats) {
      const root = $("#statsSummary");
      if (!root || !stats) return;
      const totals = stats.totals || {};
      const tokens = totals.tokens || {};
      const requests = totals.requests || {};
      const speed = totals.speed || {};
      const latency = totals.latency || {};
      const context = totals.context || {};
      const cards = [
        statsMetric(settings.totalTokensLabel, fmtTokens(tokens.total), `${fmtTokens(tokens.prompt)} ${settings.tokenDetailInput} · ${fmtTokens(tokens.generation)} ${settings.tokenDetailOutput}`, settings.heroFirstMetric ? "stats-metric-hero" : ""),
        statsMetric(settings.requestLabel, fmtTokens(requests.total), requestDetail(requests)),
      ];

      if (settings.includeRuntimeModels) {
        const liveModelCount = stats.live?.models?.length || state.status?.runningModels?.length || 0;
        const historicalModelCount = Math.max(0, (stats.models || []).length - liveModelCount);
        cards.push(statsMetric(settings.currentInstanceLabel, `${fmtTokens(liveModelCount)} 个`, `${fmtTokens(historicalModelCount)} 个历史模型保留累计消耗`));
      }

      cards.push(
        statsMetric(settings.currentSpeedLabel, fmtRate(speed.recentOutputTokensPerSecond, " tok/s"), `${fmtRate(speed.recentPromptTokensPerSecond, " in/s")} · ${fmtRate(speed.recentRequestsPerMinute, " req/min")}`),
        statsMetric(settings.latencyLabel, fmtSeconds(latency.avgE2eSeconds), `TTFT ${fmtSeconds(latency.avgTtftSeconds)}`),
        statsMetric(settings.kvLabel, formatContextUsage(context.activeTokens, context.capacityTokens, context.kvUsagePercent), settings.kvDetail),
      );

      if (settings.includePrefixCache) {
        const cacheHit = tokens.prompt ? Number(tokens.cachedPrompt || 0) / tokens.prompt : 0;
        cards.push(statsMetric(settings.prefixCacheLabel, fmtPct(cacheHit), `${fmtTokens(tokens.cachedPrompt || 0)} / ${fmtTokens(tokens.prompt)} 输入 token 命中`));
      }

      cards.push(statsMetric(settings.uptimeLabel, stats.uptimeSeconds ? formatDuration(stats.uptimeSeconds) : "-", `${settings.lifetimeLabel} ${fmtRate(speed.lifetimeTokensPerSecond, " tok/s")}`));
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
