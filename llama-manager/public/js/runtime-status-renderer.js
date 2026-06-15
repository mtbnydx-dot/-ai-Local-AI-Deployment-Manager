(function () {
  function create(deps = {}) {
    const {
      $,
      state,
      escapeHtml,
      escapeAttr,
      fmtBytes,
      fmtNumber,
      fmtTokens,
      fmtPct,
      fmtRate,
      formatDuration,
      inferGpuGeneration,
      renderIcons,
      setMetricState,
      getLiveTokensPerSecond,
      getVisibleGpus,
      updateParallelDefaults,
      updateMemoryEstimate,
      renderGpuPlan,
      renderRuntimeFacts,
      options = {},
    } = deps;

    const copy = {
      subtitlePrefix: "Local AI",
      defaultContainerName: "local-ai",
      noRunningText: "当前没有运行中的模型。启动模型后，这里会显示服务名、API 地址和卸载按钮。",
      loadingTitle: "模型容器正在运行",
      loadingText: "API 还没有返回模型列表，可能仍在加载权重、编译或 warmup。",
      unloadTitle: "停止容器并释放显存",
      claudeDetail: "Anthropic Messages 桥接到 OpenAI chat completions。",
      openAiDetail: "/chat/completions、/models 由模型服务原生提供",
      includeClaudeModelAlias: false,
      defaultClaudeModelAlias: "claude-opus-4-7",
      includeApiKeyBadge: false,
      showSpeed: false,
      showKvBar: false,
      defaultGpuSelection: "first",
      contextWarnPct: 85,
      contextFailPct: 0,
      vramWarnPct: 92,
      vramFailPct: 0,
      onGpuPickerStable: null,
      onNoGpus: null,
      syncTestModelFromRunning: false,
      ...options,
    };

    function renderStatusSummary() {
      const status = state.status || {};
      setText("#dockerStatus", status.docker?.ok ? "可用" : "异常");
      applyMetricState("dockerStatus", status.docker?.ok ? "ok" : "fail");

      if (status.gpu?.ok) {
        const gpuLabel = status.gpu.count > 1 ? `${status.gpu.count} 张 GPU` : status.gpu.name;
        setText("#gpuStatus", `${gpuLabel} · ${status.gpu.usedMb}/${status.gpu.totalMb} MB`);
        setText("#subtitle", `${copy.subtitlePrefix} / Docker / ${gpuLabel}`);
        applyMetricState("gpuStatus", Number(status.gpu.util || 0) > 90 ? "warn" : "ok");
      } else {
        setText("#gpuStatus", "未检测到");
        setText("#subtitle", `${copy.subtitlePrefix} / Docker`);
        applyMetricState("gpuStatus", "warn");
      }

      if (status.container?.running) {
        setText("#serviceStatus", status.container.status || "运行中");
        applyMetricState("serviceStatus", "ok");
      } else if (status.container?.exists) {
        setText("#serviceStatus", status.container.status || "已停止");
        applyMetricState("serviceStatus", "warn");
      } else {
        setText("#serviceStatus", "未启动");
        applyMetricState("serviceStatus", "warn");
      }

      const served = status.servedModels || [];
      setText("#servedModel", served.length ? served.map((item) => item.id).join(", ") : "-");
      applyMetricState("servedModel", served.length ? "ok" : "warn");
      if (served[0] && $("#testModel")) $("#testModel").value = served[0].id;
      if (status.endpoint?.port && $("#apiDocsLink")) {
        $("#apiDocsLink").href = `http://127.0.0.1:${status.endpoint.port}/docs`;
      }
    }

    function renderStatusInsights() {
      if (!$("#vramStatus")) return;
      const gpu = state.status?.gpu || {};
      if (gpu.ok && gpu.totalMb) {
        const usedPct = (Number(gpu.usedMb || 0) / Number(gpu.totalMb || 1)) * 100;
        $("#vramStatus").textContent = `${usedPct.toFixed(1)}% · ${fmtBytes(Number(gpu.usedMb || 0) * 1024 ** 2)} / ${fmtBytes(Number(gpu.totalMb || 0) * 1024 ** 2)}`;
        applyMetricState("vramStatus", metricStateFromPct(usedPct, copy.vramWarnPct, copy.vramFailPct));
      } else {
        $("#vramStatus").textContent = "-";
        applyMetricState("vramStatus", "warn");
      }

      const model = (state.status?.runningModels || [])[0] || {};
      const capacity = model.contextCapacityTokens || model.maxModelLen || 0;
      const used = model.contextUsedTokens || model.contextUsed || 0;
      const contextPct = capacity ? (used / capacity) * 100 : 0;
      $("#contextStatus").textContent = capacity
        ? `${fmtTokens(used)} / ${fmtTokens(capacity)} · ${contextPct.toFixed(1)}%`
        : state.status?.container?.running ? "等待指标" : "-";
      applyMetricState("contextStatus", capacity ? metricStateFromPct(contextPct, copy.contextWarnPct, copy.contextFailPct) : "warn");

      const speed = getLiveTokensPerSecond();
      $("#speedStatus").textContent = speed ? `${speed.toFixed(1)} tok/s` : "-";
      applyMetricState("speedStatus", speed ? "ok" : "warn");

      const automation = state.automationSettings || {};
      const idleEnabled = Boolean(automation.idleUnload?.enabled || automation.idleUnloadEnabled);
      const vramEnabled = Boolean(automation.vramGuard?.enabled || automation.vramGuardEnabled);
      $("#idleStatus").textContent = idleEnabled || vramEnabled
        ? `${idleEnabled ? "空闲卸载" : ""}${idleEnabled && vramEnabled ? " · " : ""}${vramEnabled ? "显存保护" : ""}`
        : "未开启";
      applyMetricState("idleStatus", idleEnabled || vramEnabled ? "ok" : "warn");
    }

    function renderRunningModels() {
      const root = $("#runningModelList");
      if (!root || !state.status) return;
      const status = state.status;
      const models = status.runningModels || [];
      const endpoint = status.endpoint || {};
      const compatEndpoints = renderCompatEndpoints(endpoint);

      if (!status.container?.running) {
        root.innerHTML = `<div class="empty compact">${escapeHtml(copy.noRunningText)}</div>`;
        if (typeof renderRuntimeFacts === "function") renderRuntimeFacts(status);
        renderIcons();
        return;
      }

      if (!models.length) {
        root.innerHTML = `
          <div class="running-model-row">
            <div>
              <h4>${escapeHtml(copy.loadingTitle)}</h4>
              <p>${escapeHtml(copy.loadingText)}</p>
              <div class="running-meta">
                <span>容器：${escapeHtml(status.container.name || copy.defaultContainerName)}</span>
                <span>状态：${escapeHtml(status.container.status || "running")}</span>
                <span>API：${escapeHtml(endpoint.localUrl || "-")}</span>
              </div>
              ${compatEndpoints}
            </div>
            <button class="job-action-button danger" data-running-action="unload-model">
              <i data-lucide="trash-2"></i><span>卸载</span>
            </button>
          </div>
        `;
        if (typeof renderRuntimeFacts === "function") renderRuntimeFacts(status);
        renderIcons();
        return;
      }

      root.innerHTML = models.map((model) => renderRunningModelRow(model, status, endpoint, compatEndpoints)).join("");
      injectRunningContextBadges(root, models);
      if (typeof renderRuntimeFacts === "function") renderRuntimeFacts(status);
      if (copy.syncTestModelFromRunning) {
        const testModel = $("#testModel");
        if (testModel && testModel.dataset.userEdited !== "true" && models[0]?.id && testModel.value !== models[0].id) {
          testModel.value = models[0].id;
        }
      }
      renderIcons();
    }

    function renderGpuPicker() {
      const root = $("#gpuPicker");
      const gpus = getVisibleGpus();
      if (!root) return;
      if (!gpus.length) {
        root.innerHTML = `<div class="empty compact">未检测到 NVIDIA GPU；启动时会保留 Docker 默认 GPU 设置。</div>`;
        state.gpuSignature = "";
        if (typeof copy.onNoGpus === "function") copy.onNoGpus();
        if (typeof renderGpuPlan === "function") renderGpuPlan();
        if (typeof updateMemoryEstimate === "function") updateMemoryEstimate();
        return;
      }

      const signature = gpus.map((gpu) => `${gpu.id}:${gpu.name}:${gpu.totalMb}`).join("|");
      if (!state.gpuSelectionTouched && !state.selectedGpuIds.size) {
        state.selectedGpuIds = new Set(copy.defaultGpuSelection === "all" ? gpus.map((gpu) => gpu.id) : [gpus[0].id]);
      }
      if (state.gpuSignature === signature && root.querySelector("[name='gpuDeviceIds']")) {
        if (typeof copy.onGpuPickerStable === "function") copy.onGpuPickerStable();
        return;
      }
      state.gpuSignature = signature;

      root.innerHTML = gpus.map((gpu) => {
        const checked = state.selectedGpuIds.has(gpu.id) ? "checked" : "";
        const freeMb = Math.max(0, Number(gpu.totalMb || 0) - Number(gpu.usedMb || 0));
        const generation = inferGpuGeneration(gpu.name);
        const usage = `free ${fmtBytes(freeMb * 1024 ** 2)} · used ${gpu.usedMb}/${gpu.totalMb} MB · ${gpu.util}% · ${gpu.temp}°C${generation ? ` · ${generation}` : ""}`;
        return `
          <label class="gpu-card">
            <input type="checkbox" name="gpuDeviceIds" value="${escapeAttr(gpu.id)}" ${checked} />
            <span>
              <strong>GPU ${escapeHtml(gpu.id)} · ${escapeHtml(gpu.name)}</strong>
              <small>${escapeHtml(usage)}</small>
            </span>
          </label>
        `;
      }).join("");
      updateParallelDefaults();
      if (typeof renderGpuPlan === "function") renderGpuPlan();
    }

    function renderRunningModelRow(model, status, endpoint, compatEndpoints) {
      const maxLen = model.maxModelLen ? `${fmtNumber(model.maxModelLen)} tokens` : "未报告";
      const created = model.createdAt ? new Date(model.createdAt).toLocaleString() : "运行中";
      const gpu = model.gpu || (status.gpu?.ok ? `${status.gpu.usedMb}/${status.gpu.totalMb} MB (${status.gpu.util}%)` : "未检测到");
      return `
        <div class="running-model-row">
          <div>
            <h4>${escapeHtml(model.id || "未命名模型")}</h4>
            <p>${escapeHtml(model.apiBaseUrl || endpoint.localUrl || "-")}</p>
            ${compatEndpoints}
            <div class="running-meta">
              <span>上下文：${escapeHtml(maxLen)}</span>
              <span>GPU：${escapeHtml(gpu)}</span>
              <span>启动：${escapeHtml(created)}</span>
              <span>容器：${escapeHtml(model.containerStatus || status.container.status || "running")}</span>
              ${copy.includeApiKeyBadge && status.apiKeyRequired ? `<span class="pill warn" title="该服务已启用 API Key，客户端需要以 Bearer Token 方式携带">API Key 已启用</span>` : ""}
            </div>
            ${copy.showSpeed ? renderRunningSpeed(model) : ""}
            ${copy.showKvBar ? renderRunningKvBar(model) : ""}
          </div>
          <button class="job-action-button danger" data-running-action="unload-model" data-model="${escapeAttr(model.id || "")}" title="${escapeAttr(copy.unloadTitle)}">
            <i data-lucide="trash-2"></i><span>卸载</span>
          </button>
        </div>
      `;
    }

    function renderCompatEndpoints(endpoint) {
      const openai = endpoint.compat?.openai || {};
      const claude = endpoint.compat?.claude || {};
      const modelAlias = claude.modelAlias || copy.defaultClaudeModelAlias;
      const claudeDetail = copy.includeClaudeModelAlias
        ? `Base URL 用 ${escapeHtml(claude.baseUrl || "-")}；模型名用 ${escapeHtml(modelAlias)}`
        : copy.claudeDetail;
      return `
        <div class="compat-endpoints">
          <div>
            <strong>OpenAI 兼容</strong>
            <code>${escapeHtml(openai.baseUrl || endpoint.localUrl || "-")}</code>
            <span>${escapeHtml(copy.openAiDetail)}</span>
          </div>
          <div>
            <strong>Claude 兼容</strong>
            <code>${escapeHtml(claude.messagesUrl || "-")}</code>
            <span>${claudeDetail}</span>
          </div>
        </div>
      `;
    }

    function injectRunningContextBadges(root, models) {
      root.querySelectorAll(".running-model-row .running-meta").forEach((meta, index) => {
        const model = models[index];
        if (!model) return;
        const badge = document.createElement("span");
        badge.textContent = `活跃 KV：${formatContextUsage(model.contextUsedTokens, model.contextCapacityTokens, model.contextUsagePercent)}`;
        meta.insertBefore(badge, meta.children[1] || null);
      });
    }

    function formatContextUsage(used, capacity, percent) {
      const usedText = fmtTokens(used);
      if (capacity) return `${usedText} / ${fmtTokens(capacity)} tokens · KV ${fmtPct(percent)}`;
      return `${usedText} tokens · KV ${fmtPct(percent)}`;
    }

    function renderRunningSpeed(model) {
      const lifetime = Number(model.lifetimeOutputTokensPerSecond || 0);
      const activeSeconds = Number(model.activeSeconds || 0);
      const recent = Number(model.recentOutputTokensPerSecond || 0);
      const running = Number(model.runningRequests || 0);
      const waiting = Number(model.waitingRequests || 0);
      const outputTokens = Number(model.outputTokens || 0);
      if (!lifetime && !recent && !running && !waiting && !outputTokens) {
        return `<div class="running-speed idle"><div class="running-speed-main"><span>启动以来平均速度</span><strong>等待首个请求</strong></div><div class="running-speed-meta"><span>产生输出后会显示活跃时间内的平均 tok/s</span></div></div>`;
      }
      const liveClass = running > 0 ? "active" : "";
      const metaParts = [];
      if (outputTokens) metaParts.push(`累计输出 ${fmtTokens(outputTokens)} tokens`);
      if (activeSeconds > 0) metaParts.push(`活跃约 ${formatDuration(activeSeconds)}`);
      if (recent > 0) metaParts.push(`实时 ${fmtRate(recent, " tok/s")}`);
      metaParts.push(`<span class="running-activity ${liveClass}">${fmtNumber(running)} 进行中 · ${fmtNumber(waiting)} 排队</span>`);
      return `
        <div class="running-speed">
          <div class="running-speed-main">
            <span title="累计生成 token ÷ 实际生成耗时，覆盖整个启动周期，不含空闲等待">启动以来平均速度（活跃时间）</span>
            <strong>${escapeHtml(lifetime ? fmtRate(lifetime, " tok/s") : "-")}</strong>
          </div>
          <div class="running-speed-meta">${metaParts.join("<span class=\"dot-sep\">·</span>")}</div>
        </div>
      `;
    }

    function renderRunningKvBar(model) {
      const percent = Number(model.contextUsagePercent || 0);
      const used = Number(model.contextUsedTokens || 0);
      const capacity = Number(model.contextCapacityTokens || 0);
      if (!capacity && !used && !percent) return "";
      const pct = Math.min(100, Math.max(0, percent));
      const stateClass = pct > 90 ? "fail" : pct > 70 ? "warn" : "ok";
      const label = capacity
        ? `${fmtTokens(used)} / ${fmtTokens(capacity)} tokens · ${fmtPct(percent)}`
        : `${fmtTokens(used)} tokens · ${fmtPct(percent)}`;
      return `
        <div class="kv-usage">
          <div class="kv-usage-head"><span>实时 KV cache 占用</span><span>${escapeHtml(label)}</span></div>
          <div class="kv-usage-track"><div class="kv-usage-fill ${stateClass}" style="width:${pct}%"></div></div>
        </div>
      `;
    }

    function metricStateFromPct(value, warn, fail) {
      if (fail && value > fail) return "fail";
      return value > warn ? "warn" : "ok";
    }

    function applyMetricState(id, value) {
      if (typeof setMetricState === "function") setMetricState(id, value);
    }

    function setText(selector, value) {
      const element = $(selector);
      if (element) element.textContent = value;
    }

    return {
      renderStatusSummary,
      renderStatusInsights,
      renderRunningModels,
      renderGpuPicker,
      renderCompatEndpoints,
      formatContextUsage,
    };
  }

  window.LocalAiRuntimeStatusRenderer = { create };
})();
