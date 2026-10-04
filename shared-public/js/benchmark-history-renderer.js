// Benchmark history and A/B comparison. Both managers mount the same renderer:
// the only engine-specific part is which config keys come back from the API,
// and those are rendered generically from whatever the comparison reports.
(function initBenchmarkHistoryRenderer() {
  const CONFIG_LABELS = {
    engine: "引擎",
    runtimeImage: "运行时镜像",
    quantization: "权重量化",
    dtype: "计算精度",
    kvCacheDtype: "KV 精度",
    maxModelLen: "上下文长度",
    maxNumSeqs: "并发/槽数",
    maxNumBatchedTokens: "批处理 token",
    gpuMemoryUtilization: "显存利用率",
    tensorParallelSize: "TP",
    pipelineParallelSize: "PP",
    multiGpuMode: "多卡模式",
    gpuIds: "GPU",
    gpuLayers: "GPU layers",
    tensorSplit: "tensor split",
    cacheTypeK: "cache-type-k",
    cacheTypeV: "cache-type-v",
    speculativeMode: "推测解码",
    numSpeculativeTokens: "推测 token",
    enablePrefixCaching: "前缀缓存",
    cpuOffloadGb: "CPU offload GB",
    kvOffloadingSize: "KV offload GB",
  };

  function create(deps = {}) {
    const api = deps.api;
    const escapeHtml = deps.escapeHtml || ((value) => String(value ?? ""));
    const escapeAttr = deps.escapeAttr || escapeHtml;
    const notify = deps.notify || (() => {});
    const confirmAction = deps.confirmAction || (async () => true);
    const getElement = deps.$ || deps.getElement || ((selector) => document.querySelector(selector));
    const renderIcons = deps.renderIcons || (() => {});
    if (typeof api !== "function") throw new Error("LocalAiBenchmarkHistory.create requires api.");

    // Selection lives here rather than in the DOM so a refresh keeps the
    // comparison the user set up.
    const selected = new Set();
    let baselineId = "";
    let runs = [];
    let modelFilter = "";

    function formatValue(value, digits) {
      if (!Number.isFinite(value)) return "-";
      return value.toFixed(digits);
    }

    function formatDelta(entry, isBaseline) {
      if (isBaseline) return `<span class="benchmark-delta baseline">基线</span>`;
      if (entry.deltaPercent === null || !Number.isFinite(entry.deltaPercent)) return `<span class="benchmark-delta">-</span>`;
      const sign = entry.deltaPercent > 0 ? "+" : "";
      const tone = entry.improved === null ? "" : entry.improved ? " better" : " worse";
      return `<span class="benchmark-delta${tone}">${sign}${entry.deltaPercent.toFixed(1)}%</span>`;
    }

    function configText(run, key) {
      const value = run.config?.[key];
      if (value === undefined || value === null || value === "") return "-";
      if (typeof value === "boolean") return value ? "开" : "关";
      return String(value);
    }

    function runTitle(run) {
      const when = new Date(run.at).toLocaleString();
      return run.label ? `${run.label} · ${when}` : when;
    }

    function renderList() {
      const root = getElement("#benchmarkHistoryList");
      if (!root) return;
      if (!runs.length) {
        root.innerHTML = `<div class="empty compact">暂无测速记录。跑一次测速后，这里会连同当时的启动参数一起保存，供后续对比。</div>`;
        return;
      }
      root.innerHTML = runs.map((run) => {
        const checked = selected.has(run.id) ? " checked" : "";
        const isBaseline = baselineId === run.id;
        return `
          <div class="benchmark-history-row${isBaseline ? " baseline" : ""}">
            <label class="check-row">
              <input type="checkbox" data-benchmark-select="${escapeAttr(run.id)}"${checked} />
              <span>${escapeHtml(runTitle(run))}</span>
            </label>
            <span class="benchmark-history-model" title="${escapeAttr(run.model)}">${escapeHtml(run.model)}</span>
            <span class="benchmark-history-metric">${formatValue(run.metrics.wallTokensPerSecond, 1)} tok/s</span>
            <span class="benchmark-history-metric">TTFT ${formatValue(run.metrics.avgTtftMs, 0)} ms</span>
            <span class="benchmark-history-metric">C${run.load.concurrency} · ${run.load.requests} 次</span>
            <button type="button" class="job-action-button" data-benchmark-baseline="${escapeAttr(run.id)}" title="设为对比基线">基线</button>
            <button type="button" class="job-action-button" data-benchmark-delete="${escapeAttr(run.id)}" title="删除这条记录">删除</button>
          </div>`;
      }).join("");
      renderIcons();
    }

    function renderComparison(comparison) {
      const root = getElement("#benchmarkCompareResult");
      if (!root) return;
      if (!comparison || comparison.runs.length < 2) {
        root.innerHTML = `<div class="empty compact">勾选两条及以上记录即可对比。第一条默认作为基线，也可以点「基线」改成别的。</div>`;
        return;
      }
      const header = comparison.runs
        .map((run) => `<th scope="col">${escapeHtml(runTitle(run))}${run.id === comparison.baselineId ? " <em>基线</em>" : ""}</th>`)
        .join("");
      const configRows = comparison.configKeys.length
        ? comparison.configKeys.map((key) => `
            <tr>
              <th scope="row">${escapeHtml(CONFIG_LABELS[key] || key)}</th>
              ${comparison.runs.map((run) => `<td>${escapeHtml(configText(run, key))}</td>`).join("")}
            </tr>`).join("")
        : `<tr><td colspan="${comparison.runs.length + 1}">所选记录的启动参数完全相同，差异只来自运行环境或随机波动。</td></tr>`;
      const metricRows = comparison.metrics.map((metric) => `
        <tr>
          <th scope="row">${escapeHtml(metric.label)}</th>
          ${metric.values.map((entry) => `
            <td>
              <span class="benchmark-value">${formatValue(entry.value, metric.digits)}</span>
              ${formatDelta(entry, entry.id === comparison.baselineId)}
            </td>`).join("")}
        </tr>`).join("");
      root.innerHTML = `
        <table class="benchmark-compare-table">
          <caption>配置差异</caption>
          <thead><tr><th scope="col">参数</th>${header}</tr></thead>
          <tbody>${configRows}</tbody>
        </table>
        <table class="benchmark-compare-table">
          <caption>性能对比（相对基线）</caption>
          <thead><tr><th scope="col">指标</th>${header}</tr></thead>
          <tbody>${metricRows}</tbody>
        </table>`;
    }

    async function refreshComparison() {
      const ids = runs.filter((run) => selected.has(run.id)).map((run) => run.id);
      if (ids.length < 2) {
        renderComparison(null);
        return;
      }
      try {
        const query = new URLSearchParams({ ids: ids.join(",") });
        if (baselineId && ids.includes(baselineId)) query.set("baselineId", baselineId);
        renderComparison(await api(`/api/benchmarks/compare?${query}`));
      } catch (error) {
        notify(`对比失败：${error.message}`, true);
      }
    }

    async function refresh() {
      try {
        const query = new URLSearchParams({ limit: "50" });
        if (modelFilter) query.set("model", modelFilter);
        const result = await api(`/api/benchmarks?${query}`);
        runs = Array.isArray(result.runs) ? result.runs : [];
        // Drop selections whose run was pruned or deleted elsewhere.
        for (const id of [...selected]) if (!runs.some((run) => run.id === id)) selected.delete(id);
        if (baselineId && !selected.has(baselineId)) baselineId = "";
        renderModelFilter(result.models || []);
        renderList();
        await refreshComparison();
      } catch (error) {
        notify(`读取测速历史失败：${error.message}`, true);
      }
    }

    function renderModelFilter(models) {
      const select = getElement("#benchmarkHistoryModel");
      if (!select) return;
      const current = modelFilter;
      select.innerHTML = [`<option value="">全部模型</option>`]
        .concat(models.map((model) => `<option value="${escapeAttr(model)}">${escapeHtml(model)}</option>`))
        .join("");
      select.value = current;
    }

    function mount() {
      const root = getElement("#benchmarkHistoryPanel");
      if (!root) return;
      root.addEventListener("change", (event) => {
        const selectId = event.target?.dataset?.benchmarkSelect;
        if (selectId) {
          if (event.target.checked) selected.add(selectId);
          else {
            selected.delete(selectId);
            if (baselineId === selectId) baselineId = "";
          }
          renderList();
          refreshComparison();
          return;
        }
        if (event.target?.id === "benchmarkHistoryModel") {
          modelFilter = event.target.value;
          refresh();
        }
      });
      root.addEventListener("click", async (event) => {
        const baseline = event.target?.dataset?.benchmarkBaseline;
        if (baseline) {
          // Making a run the baseline implies comparing against it.
          selected.add(baseline);
          baselineId = baseline;
          renderList();
          await refreshComparison();
          return;
        }
        const remove = event.target?.dataset?.benchmarkDelete;
        if (!remove) return;
        const run = runs.find((item) => item.id === remove);
        if (!await confirmAction({
          title: "删除测速记录",
          body: `将删除 ${runTitle(run || { at: new Date().toISOString() })} 的测速记录。容器和模型不受影响。`,
          confirmText: "删除",
          danger: true,
        })) return;
        try {
          await api(`/api/benchmarks/${encodeURIComponent(remove)}`, { method: "DELETE" });
          selected.delete(remove);
          if (baselineId === remove) baselineId = "";
          await refresh();
        } catch (error) {
          notify(`删除失败：${error.message}`, true);
        }
      });
      refresh();
    }

    return { mount, refresh };
  }

  window.LocalAiBenchmarkHistory = { create };
}());
