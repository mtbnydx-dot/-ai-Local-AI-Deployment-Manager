(function () {
  function defaultEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function helper(options, name, fallback) {
    return typeof options?.[name] === "function" ? options[name] : fallback;
  }

  function hasFiniteNumber(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  }

  function statsMetric(label, value, detail, options = {}) {
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const escapeAttr = helper(options, "escapeAttr", defaultEscape);
    const className = options.className || "";
    return `
      <div class="stats-metric ${escapeAttr(className)}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(detail || "")}</small>
      </div>
    `;
  }

  function miniStat(label, value, detail, options = {}) {
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    return `
      <div class="mini-stat">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value ?? "-")}</strong>
        <small>${escapeHtml(detail || "")}</small>
      </div>
    `;
  }

  function shareBar(label, value, options = {}) {
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const percent = Math.min(100, Math.max(0, Number(value || 0) * 100));
    return `
      <div class="share-bar">
        <span>${escapeHtml(label)}</span>
        <div><b style="width:${percent}%"></b></div>
        <em>${percent.toFixed(1)}%</em>
      </div>
    `;
  }

  function renderCosts(stats, options = {}) {
    const root = options.root || document.querySelector(options.rootSelector || "#statsCostTable");
    if (!root) return;
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const fmtMoney = helper(options, "fmtMoney", (value) => `$${Number(value || 0).toFixed(2)}`);
    const labels = {
      empty: "No cost comparison yet.",
      model: "Model",
      price: "Input/output",
      standard: "Standard equivalent",
      cached: "Cached equivalent",
      priceAsOf: "Prices use",
      publicPrice: "public pricing estimates",
      localPrefix: "local",
      localNote: "does not incur these API costs; shown only for value comparison.",
      priceSeparator: " / ",
      ...(options.labels || {}),
    };
    const rows = stats.costComparison || [];
    if (!rows.length) {
      root.innerHTML = `<div class="empty compact">${escapeHtml(labels.empty)}</div>`;
      return;
    }
    const managerName = options.managerName || "local";
    root.innerHTML = `
      <div class="cost-row cost-head">
        <span>${escapeHtml(labels.model)}</span>
        <span>${escapeHtml(labels.price)}</span>
        <span>${escapeHtml(labels.standard)}</span>
        <span>${escapeHtml(labels.cached)}</span>
      </div>
      ${rows.map((row) => `
        <div class="cost-row">
          <span><strong>${escapeHtml(row.provider)}</strong> ${escapeHtml(row.label)}</span>
          <span>$${escapeHtml(row.inputPerM)}/M${escapeHtml(labels.priceSeparator)}$${escapeHtml(row.outputPerM)}/M</span>
          <span>${fmtMoney(row.standardCost)}</span>
          <span>${fmtMoney(row.cachedEquivalentCost)}</span>
        </div>
      `).join("")}
      <div class="stats-source-note">
        ${escapeHtml(labels.priceAsOf)} ${escapeHtml(stats.pricingAsOf || "current")} ${escapeHtml(labels.publicPrice)}; ${escapeHtml(labels.localPrefix)} ${escapeHtml(managerName)} ${escapeHtml(labels.localNote)}
      </div>
    `;
  }

  function renderDetails(stats, options = {}) {
    const root = options.root || document.querySelector(options.rootSelector || "#statsDetailGrid");
    if (!root) return;
    const fmtSeconds = helper(options, "fmtSeconds", (value) => String(value || "-"));
    const fmtTokens = helper(options, "fmtTokens", (value) => String(value || 0));
    const renderMiniStat = helper(options, "miniStat", miniStat);
    const labels = {
      endToEnd: "End-to-end latency",
      endToEndDetail: "Average request completion time",
      ttft: "Time to first token",
      perOutputToken: "Per output token",
      lowerIsBetter: "Lower is faster",
      gpu: "GPU",
      gpuMissing: "Not detected",
      kvCapacity: "KV cache capacity",
      maxConcurrency: "max concurrency",
      loadWeights: "Weight loading",
      loadStage: "Model loading stage",
      torchCompile: "torch.compile",
      firstStartCost: "One major first-start cost",
      warmup: "warmup",
      warmupDetail: "profiling / warmup",
      cudaGraph: "CUDA graph",
      graphPool: "graph pool actual usage",
      source: "Source",
      separator: " / ",
      temperatureUnit: "C",
      ...(options.labels || {}),
    };
    const facts = stats.facts || {};
    const totals = stats.totals || {};
    const latency = totals.latency || {};
    const gpuParts = stats.gpu?.ok
      ? [
          `${stats.gpu.usedMb}/${stats.gpu.totalMb} MB`,
          `${stats.gpu.util}%`,
          `${stats.gpu.temp}${labels.temperatureUnit}`,
          hasFiniteNumber(stats.gpu.powerWatts) ? `${Number(stats.gpu.powerWatts).toFixed(0)} W` : "",
          hasFiniteNumber(stats.gpu.fanPercent) ? `${Number(stats.gpu.fanPercent).toFixed(0)}% fan` : "",
        ].filter(Boolean)
      : [];
    const gpu = gpuParts.length ? gpuParts.join(labels.separator) : labels.gpuMissing;
    root.innerHTML = [
      renderMiniStat(labels.endToEnd, fmtSeconds(latency.avgE2eSeconds), labels.endToEndDetail),
      renderMiniStat(labels.ttft, fmtSeconds(latency.avgTtftSeconds), "time to first token"),
      renderMiniStat(labels.perOutputToken, fmtSeconds(latency.avgTimePerOutputTokenSeconds), labels.lowerIsBetter),
      renderMiniStat(labels.gpu, gpu, stats.gpu?.name || ""),
      renderMiniStat(labels.kvCapacity, facts.kvCacheTokens ? `${fmtTokens(facts.kvCacheTokens)} tokens` : "-", facts.maxConcurrency ? `${labels.maxConcurrency} ${facts.maxConcurrency}x` : ""),
      renderMiniStat(labels.loadWeights, facts.modelLoadSeconds ? `${fmtSeconds(facts.modelLoadSeconds)}${labels.separator}${facts.modelLoadMemoryGiB} GiB` : "-", labels.loadStage),
      renderMiniStat(labels.torchCompile, fmtSeconds(facts.torchCompileSeconds), labels.firstStartCost),
      renderMiniStat(labels.warmup, fmtSeconds(facts.warmupSeconds), labels.warmupDetail),
      renderMiniStat(labels.cudaGraph, facts.graphCaptureGiB ? `${facts.graphCaptureGiB} GiB` : "-", labels.graphPool),
      renderMiniStat(labels.source, stats.source || "-", `${fmtTokens(stats.rawMetricCount)} metrics`),
    ].join("");
  }

  function renderHistoryTrends(stats, options = {}) {
    const root = options.root || document.querySelector(options.rootSelector || "#statsTrends");
    if (!root) return;
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const samples = Array.isArray(stats?.trends?.samples) ? stats.trends.samples : [];
    const labels = {
      empty: "No persisted performance samples yet. The manager records one sample per minute while it is running.",
      current: "Current",
      average: "Average",
      range: "24-hour persisted history",
      ttft: "TTFT",
      tpot: "TPOT",
      e2e: "End-to-end",
      queue: "Queue wait",
      outputTps: "Output throughput",
      rpm: "Requests/min",
      waiting: "Waiting requests",
      gpuTemp: "GPU temperature",
      gpuPower: "GPU power",
      gpuFan: "GPU fan",
      mtpAcceptance: "MTP acceptance",
      ...(options.labels || {}),
    };
    if (!samples.length) {
      root.innerHTML = `<div class="empty compact">${escapeHtml(labels.empty)}</div>`;
      return;
    }
    const fmtMs = helper(options, "fmtMs", (value) => `${Number(value || 0).toFixed(0)} ms`);
    const fmtRate = helper(options, "fmtRate", (value, suffix = "") => `${Number(value || 0).toFixed(1)}${suffix}`);
    const formatDateTime = helper(options, "formatDateTime", (value) => String(value || ""));
    const definitions = [
      { label: labels.ttft, path: "latency.ttftMs", color: "var(--blue)", format: fmtMs },
      { label: labels.tpot, path: "latency.tpotMs", color: "var(--teal)", format: fmtMs },
      { label: labels.e2e, path: "latency.e2eMs", color: "var(--amber)", format: fmtMs },
      { label: labels.queue, path: "latency.queueMs", color: "var(--red)", format: fmtMs },
      { label: labels.outputTps, path: "throughput.outputTokensPerSecond", color: "var(--green)", format: (value) => fmtRate(value, " tok/s") },
      { label: labels.rpm, path: "throughput.requestsPerMinute", color: "var(--blue)", format: (value) => fmtRate(value, " rpm") },
      { label: labels.waiting, path: "requests.waiting", color: "var(--amber)", format: (value) => String(Math.round(Number(value || 0))) },
      { label: labels.gpuTemp, path: "gpu.temperatureC", color: "var(--red)", format: (value) => `${Number(value || 0).toFixed(0)} C`, optional: true },
      { label: labels.gpuPower, path: "gpu.powerWatts", color: "var(--amber)", format: (value) => `${Number(value || 0).toFixed(0)} W`, optional: true },
      { label: labels.gpuFan, path: "gpu.fanPercent", color: "var(--teal)", format: (value) => `${Number(value || 0).toFixed(0)}%`, optional: true },
      { label: labels.mtpAcceptance, path: "speculative.acceptanceRate", color: "var(--green)", format: (value) => `${(Number(value || 0) * 100).toFixed(1)}%`, optional: true, speculative: true },
    ];
    const cards = definitions.map((definition) => {
      const rawValues = samples.map((sample) => nestedValue(sample, definition.path));
      const finiteValues = rawValues.filter((value) => Number.isFinite(value));
      const hasSpeculative = samples.some((sample) => sample.speculative?.enabled || Number(sample.speculative?.draftTokens || 0) > 0);
      if (!finiteValues.length || (definition.optional && definition.speculative && !hasSpeculative)) return "";
      const values = fillTrendGaps(rawValues);
      const current = finiteValues.at(-1) || 0;
      const average = finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
      return `
        <article class="trend-card">
          <div class="trend-head"><span>${escapeHtml(definition.label)}</span><strong>${escapeHtml(definition.format(current))}</strong></div>
          ${renderSparkline(values, definition.color)}
          <div class="trend-foot"><span>${escapeHtml(`${labels.average} ${definition.format(average)}`)}</span><span>${escapeHtml(labels.range)}</span></div>
        </article>
      `;
    }).filter(Boolean);
    const range = `${formatDateTime(samples[0]?.at)} - ${formatDateTime(samples.at(-1)?.at)}`;
    root.innerHTML = `${cards.join("")}<div class="trend-range-note">${escapeHtml(range)}</div>`;
  }

  function nestedValue(object, path) {
    const value = String(path || "").split(".").reduce((current, key) => current?.[key], object);
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function fillTrendGaps(values) {
    let last = 0;
    return values.map((value) => {
      if (Number.isFinite(value)) last = value;
      return last;
    });
  }

  function renderSparkline(values, color) {
    const width = 240;
    const height = 64;
    const points = Array.isArray(values) && values.length ? values : [0];
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;
    const coords = points.map((value, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = height - 5 - ((value - min) / range) * (height - 10);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="trend"><polyline fill="none" stroke="${defaultEscape(color)}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${coords}" /></svg>`;
  }

  window.statsUiRenderer = {
    statsMetric,
    miniStat,
    shareBar,
    renderCosts,
    renderDetails,
    renderHistoryTrends,
  };
}());
