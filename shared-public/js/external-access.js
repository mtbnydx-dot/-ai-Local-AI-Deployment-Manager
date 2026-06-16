(function () {
  function create(deps) {
    const {
      $,
      escapeHtml,
      escapeAttr,
      fmtTokens,
      fmtPct,
      fmtRate,
      fmtMs,
      formatDateTime,
      statsMetric,
      miniStat,
      shareBar,
      sparkline,
      renderIcons,
      summaryHeroClass = "",
      endpointDetails = {},
    } = deps;

    function renderExternalAccess(data) {
      if (!data) return;
      const totals = data.totals || {};
      const external = data.external || {};
      const local = data.local || {};
      const totalRequests = totals.requests || {};
      const externalRequests = external.requests || {};
      const externalTokens = external.tokens || {};
      const externalLatency = external.latency || {};
      const externalClients = external.clients || {};
      const service = data.service || {};
      const lastAt = external.lastAt || totals.lastAt;
      const externalShare = totalRequests.total ? (externalRequests.total || 0) / totalRequests.total : 0;
      const summaryRoot = $("#externalAccessSummary");
      if (summaryRoot) {
        summaryRoot.innerHTML = [
          statsMetric("外部请求", fmtTokens(externalRequests.total || 0), `${fmtTokens(externalRequests.success || 0)} 成功 · ${fmtTokens(externalRequests.error || 0)} 错误`, summaryHeroClass),
          statsMetric("外部客户端", fmtTokens(externalClients.unique || 0), `${fmtPct(externalShare)} 来自非本机地址`),
          statsMetric("错误率", fmtPct(externalRequests.errorRate || 0), `${fmtTokens(externalRequests.authFailures || 0)} 鉴权失败 · ${fmtTokens(externalRequests.rateLimited || 0)} 限流`),
          statsMetric("平均延迟", fmtMs(externalLatency.avgMs || 0), `P50 ${fmtMs(externalLatency.p50Ms || 0)} · P95 ${fmtMs(externalLatency.p95Ms || 0)}${externalLatency.maxMs ? ` · Max ${fmtMs(externalLatency.maxMs || 0)}` : ""}`),
          statsMetric("外部 Tokens", fmtTokens(externalTokens.total || 0), `${fmtTokens(externalTokens.input || 0)} 输入 · ${fmtTokens(externalTokens.output || 0)} 输出`),
          statsMetric("本机请求", fmtTokens(local.requests?.total || 0), "127.0.0.1 / 本机 LAN 地址会归到这里"),
          statsMetric("流式请求", fmtTokens(externalRequests.streamed || 0), `${fmtPct(externalRequests.total ? (externalRequests.streamed || 0) / externalRequests.total : 0)} 外部请求为 stream`),
          statsMetric("最后访问", lastAt ? formatDateTime(lastAt) : "-", data.logPath || "访问日志尚未产生"),
        ].join("");
      }

      const freshness = $("#externalAccessFreshness");
      if (freshness) {
        const ageMs = data.updatedAt ? Date.now() - new Date(data.updatedAt).getTime() : 0;
        const ageSec = Math.max(0, Math.round(ageMs / 1000));
        freshness.textContent = data.updatedAt ? (ageSec < 5 ? "刚刚更新" : `更新于 ${ageSec} 秒前`) : "";
      }
      const privacy = $("#externalAccessPrivacy");
      if (privacy) {
        privacy.innerHTML = `<i data-lucide="shield-check"></i><span>${escapeHtml(data.privacy || "只展示访问元数据，不展示聊天正文。")}</span>`;
      }

      renderExternalEndpoints(service);
      renderExternalWindows(external.windows || {});
      renderExternalClients(data.clients || [], externalRequests.total || 0);
      renderExternalCompactList("#externalAccessPaths", data.paths || [], totalRequests.total || 0, "暂无路径访问记录。", renderExternalPathDetail);
      renderExternalModels(data);
      renderExternalCompactList("#externalAccessAuth", data.authSources || [], totalRequests.total || 0, "暂无认证字段记录。", renderExternalAuthDetail);
      renderExternalCompactList("#externalAccessStatuses", data.statuses || [], totalRequests.total || 0, "暂无状态码记录。", renderExternalStatusDetail);
      renderExternalTimeline(data.timeline || []);
      renderExternalRecent(data.recent || []);
      renderIcons?.();
    }

    function renderExternalEndpoints(service = {}) {
      const root = $("#externalAccessEndpoints");
      if (!root) return;
      const apiKeyLabel = service.requireApiKey ? "需要 API Key" : "未强制 API Key";
      const runningLabel = service.running ? "模型服务运行中" : "模型服务未运行";
      const cards = [
        renderExternalEndpointCard("Chatbox / OpenWebUI / OpenAI SDK", service.openAiGatewayBaseUrl || "-", endpointDetails.openai || "Provider 选 OpenAI Compatible；Base URL 必须以 /serve/v1 结尾，不要填 /claude 或 /v1/messages。", service.running ? "ok" : "warn"),
        renderExternalEndpointCard("Claude / Cowork / CC Switch", service.claudeBaseUrl || "-", endpointDetails.claude || "Provider 选 Anthropic / Claude；Base URL 填 /claude，只有客户端要求完整 endpoint 时才填 /claude/v1/messages。", service.running ? "ok" : "warn"),
        renderExternalEndpointCard("仅调试：容器直连入口", service.openAiContainerBaseUrl || "-", "排错用；它会绕过管理器的 API Key、限流、审计与客户端策略，外部客户端优先用 /serve/v1。", "warn"),
        renderExternalEndpointCard("访问策略", `${apiKeyLabel} · ${fmtTokens(service.rateLimitRpm || 0)} rpm · 并发 ${fmtTokens(service.maxConcurrentRequests || 0)}`, `${runningLabel} · LAN ${service.lanAddress || "-"}`, service.requireApiKey ? "ok" : "warn"),
      ];
      root.innerHTML = cards.join("");
    }

    function renderExternalEndpointCard(label, value, detail, stateName = "ok") {
      return `
        <article class="external-endpoint-card ${escapeAttr(stateName)}">
          <span>${escapeHtml(label)}</span>
          <code>${escapeHtml(value || "-")}</code>
          <small>${escapeHtml(detail || "")}</small>
        </article>
      `;
    }

    function renderExternalWindows(windows = {}) {
      const root = $("#externalAccessWindows");
      if (!root) return;
      const rows = [
        ["m5", "最近 5 分钟"],
        ["m15", "最近 15 分钟"],
        ["h1", "最近 1 小时"],
        ["h24", "最近 24 小时"],
      ];
      root.innerHTML = rows.map(([key, label]) => {
        const item = windows[key] || {};
        const stateName = item.errorRate >= 0.2 ? "fail" : item.errorRate > 0 ? "warn" : "ok";
        return `
          <article class="external-window-card ${stateName}">
            <div class="external-window-head">
              <span>${escapeHtml(label)}</span>
              <strong>${fmtTokens(item.total || 0)}</strong>
            </div>
            <div class="stats-row-grid external-window-stats">
              ${miniStat("客户端", fmtTokens(item.uniqueClients || 0), "唯一外部 IP")}
              ${miniStat("速度", fmtRate(item.requestsPerMinute || 0, " req/min"), "窗口平均")}
              ${miniStat("错误", fmtTokens(item.error || 0), fmtPct(item.errorRate || 0))}
              ${miniStat("Tokens", fmtTokens(item.totalTokens || 0), "输入 + 输出")}
            </div>
          </article>
        `;
      }).join("");
    }

    function renderExternalClients(clients, totalRequests) {
      const root = $("#externalAccessClients");
      if (!root) return;
      if (!clients.length) {
        root.innerHTML = `<div class="empty compact">暂无外部客户端访问。其他机器连上后会按 IP 显示在这里。</div>`;
        return;
      }
      root.innerHTML = clients.map((client) => renderExternalClientRow(client, totalRequests)).join("");
    }

    function renderExternalClientRow(client, totalRequests) {
      const share = totalRequests ? Number(client.count || 0) / totalRequests : 0;
      const stateName = client.errorRate >= 0.2 ? "fail" : client.errorRate > 0 ? "warn" : "ok";
      const topModel = formatAccessCounterPair(client.topModel);
      const topPath = formatAccessCounterPair(client.topPath);
      const topAuth = formatAccessCounterPair(client.topAuthSource);
      return `
        <article class="stats-model-row external-client-row">
          <div>
            <h4>
              <span>${escapeHtml(client.key || "unknown")}</span>
              <em class="status-pill ${stateName}">${escapeHtml(stateName === "ok" ? "正常" : stateName === "warn" ? "注意" : "错误")}</em>
            </h4>
            <p>首次 ${escapeHtml(client.firstAt ? formatDateTime(client.firstAt) : "-")} · 最后 ${escapeHtml(client.lastAt ? formatDateTime(client.lastAt) : "-")}</p>
            <div class="stats-row-grid">
              ${miniStat("请求", fmtTokens(client.count || 0), `${fmtTokens(client.success || 0)} 成功 · ${fmtTokens(client.error || 0)} 错误`)}
              ${miniStat("错误率", fmtPct(client.errorRate || 0), `状态 ${topStatusLabel(client.topStatus)}`)}
              ${miniStat("延迟", fmtMs(client.avgDurationMs || 0), `Max ${fmtMs(client.maxDurationMs || 0)}`)}
              ${miniStat("Tokens", fmtTokens(client.totalTokens || 0), `${fmtTokens(client.inputTokens || 0)} 输入 · ${fmtTokens(client.outputTokens || 0)} 输出`)}
              ${miniStat("常用路径", topPath, "按请求数排序")}
              ${miniStat("请求模型", topModel, "客户端传入的 model")}
              ${miniStat("认证字段", topAuth, "实际命中的 Header")}
              ${miniStat("流式", fmtTokens(client.streamed || 0), `${fmtPct(client.count ? (client.streamed || 0) / client.count : 0)} 请求`)}
            </div>
            ${shareBar("外部请求占比", share)}
          </div>
        </article>
      `;
    }

    function renderExternalCompactList(selector, items, totalRequests, emptyText, detailFn) {
      const root = $(selector);
      if (!root) return;
      if (!items.length) {
        root.innerHTML = `<div class="empty compact">${escapeHtml(emptyText)}</div>`;
        return;
      }
      root.innerHTML = renderExternalCompactRows(items, totalRequests, detailFn);
    }

    function renderExternalModels(data = {}) {
      const root = $("#externalAccessModels");
      if (!root) return;
      const requested = data.models || [];
      const resolved = data.resolvedModels || [];
      if (!requested.length && !resolved.length) {
        root.innerHTML = `<div class="empty compact">暂无模型调用记录。</div>`;
        return;
      }
      const total = data.totals?.requests?.total || 0;
      root.innerHTML = `
        ${requested.length ? `<div class="external-list-heading">请求模型名</div>${renderExternalCompactRows(requested, total, renderExternalModelDetail)}` : ""}
        ${resolved.length ? `<div class="external-list-heading">实际解析模型</div>${renderExternalCompactRows(resolved, total, renderExternalModelDetail)}` : ""}
      `;
    }

    function renderExternalCompactRows(items, totalRequests, detailFn) {
      return items.map((item) => {
        const share = totalRequests ? Number(item.count || 0) / totalRequests : 0;
        const stateName = item.errorRate >= 0.2 ? "fail" : item.errorRate > 0 ? "warn" : "ok";
        return `
          <div class="external-compact-row">
            <div>
              <strong>${escapeHtml(item.key || "-")}</strong>
              <span>${escapeHtml(detailFn ? detailFn(item) : "")}</span>
              ${shareBar("占比", share)}
            </div>
            <em class="status-pill ${stateName}">${fmtTokens(item.count || 0)}</em>
          </div>
        `;
      }).join("");
    }

    function renderExternalTimeline(timeline) {
      const root = $("#externalAccessTimeline");
      if (!root || typeof sparkline !== "function") return;
      const hasData = timeline.some((item) => Number(item.total || 0) > 0);
      if (!hasData) {
        root.innerHTML = `<div class="empty compact">近 2 小时暂无外部请求。</div>`;
        return;
      }
      const cards = [
        { label: "请求数", key: "total", color: "var(--blue)", fmt: (v) => fmtTokens(v), detail: "每 5 分钟" },
        { label: "错误数", key: "error", color: "var(--red)", fmt: (v) => fmtTokens(v), detail: "非 2xx/3xx" },
        { label: "Tokens", key: "totalTokens", color: "var(--teal)", fmt: (v) => fmtTokens(v), detail: "输入 + 输出" },
        { label: "平均延迟", key: "avgDurationMs", color: "var(--amber)", fmt: (v) => fmtMs(v), detail: "每桶平均" },
      ];
      root.innerHTML = cards.map((card) => {
        const values = timeline.map((item) => Number(item[card.key] || 0));
        const current = values.at(-1) || 0;
        const peak = Math.max(...values);
        return `
          <div class="trend-card">
            <div class="trend-head">
              <span>${escapeHtml(card.label)}</span>
              <strong>${escapeHtml(card.fmt(current))}</strong>
            </div>
            ${sparkline(values, { color: card.color })}
            <div class="trend-foot"><span>${escapeHtml(card.detail)}</span><span>峰值 ${escapeHtml(card.fmt(peak))}</span></div>
          </div>
        `;
      }).join("");
    }

    function renderExternalRecent(events) {
      const root = $("#externalAccessRecent");
      if (!root) return;
      const rows = events.slice(0, 80);
      if (!rows.length) {
        root.innerHTML = `<div class="empty compact">暂无访问记录。远端客户端请求后会显示最近访问元数据。</div>`;
        return;
      }
      root.innerHTML = rows.map((event) => {
        const stateName = event.status >= 500 ? "fail" : event.status >= 400 ? "warn" : "ok";
        const modelText = event.model && event.resolvedModel && event.model !== event.resolvedModel
          ? `${event.model} → ${event.resolvedModel}`
          : event.model || event.resolvedModel || "-";
        return `
          <div class="external-recent-row">
            <em class="status-pill ${stateName}">${escapeHtml(String(event.status || "-"))}</em>
            <div>
              <strong>${escapeHtml(`${event.method || "-"} ${event.path || "-"}`)}</strong>
              <span>${escapeHtml(event.remoteAddress || "-")} · ${escapeHtml(event.at ? formatDateTime(event.at) : "-")} · ${escapeHtml(event.kind || "-")}</span>
            </div>
            <div class="external-recent-meta">
              <span>${escapeHtml(modelText)}</span>
              <span>${escapeHtml(event.authSource || "none")} · ${event.stream ? "stream" : "non-stream"} · ${fmtMs(event.durationMs || 0)}</span>
              <span>${fmtTokens(event.totalTokens || 0)} tokens · tools ${fmtTokens(event.toolUseCount || 0)}/${fmtTokens(event.toolSchemaCount || 0)}</span>
              ${event.error ? `<span class="external-error-text">${escapeHtml(event.error)}</span>` : ""}
            </div>
          </div>
        `;
      }).join("");
    }

    function renderExternalPathDetail(item) {
      return `${fmtTokens(item.success || 0)} 成功 · ${fmtTokens(item.error || 0)} 错误 · ${formatAccessCounterPair(item.topModel, "模型 -")}`;
    }

    function renderExternalModelDetail(item) {
      return `${fmtTokens(item.totalTokens || 0)} tokens · ${fmtTokens(item.streamed || 0)} 流式 · 错误率 ${fmtPct(item.errorRate || 0)}`;
    }

    function renderExternalAuthDetail(item) {
      return `${fmtTokens(item.success || 0)} 成功 · ${fmtTokens(item.error || 0)} 错误 · ${formatAccessCounterPair(item.topPath, "路径 -")}`;
    }

    function renderExternalStatusDetail(item) {
      return `${fmtTokens(item.totalTokens || 0)} tokens · ${formatAccessCounterPair(item.topPath, "路径 -")} · ${formatAccessCounterPair(item.topAuthSource, "认证 -")}`;
    }

    function formatAccessCounterPair(pair, fallback = "-") {
      if (!Array.isArray(pair) || !pair.length) return fallback;
      return `${pair[0] || "-"} (${fmtTokens(pair[1] || 0)})`;
    }

    function topStatusLabel(pair) {
      if (!Array.isArray(pair) || !pair.length) return "-";
      return String(pair[0] || "-");
    }

    return { renderExternalAccess };
  }

  window.LocalAiExternalAccess = { create };
})();
