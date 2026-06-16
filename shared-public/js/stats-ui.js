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
    const gpu = stats.gpu?.ok ? `${stats.gpu.usedMb}/${stats.gpu.totalMb} MB${labels.separator}${stats.gpu.util}%${labels.separator}${stats.gpu.temp}${labels.temperatureUnit}` : labels.gpuMissing;
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

  window.statsUiRenderer = {
    statsMetric,
    miniStat,
    shareBar,
    renderCosts,
    renderDetails,
  };
}());
