(function () {
  const defaultEscape = (value) => window.LocalAiDomUtils.escapeHtml(value);

  function helper(options, name, fallback) {
    return typeof options?.[name] === "function" ? options[name] : fallback;
  }

  function getLabels(options) {
    return {
      modelEmpty: "No model stats yet.",
      modelFallbackRoot: "local model",
      tokenShare: "Token share",
      requestShare: "Request share",
      outputSpeed: "Output speed",
      activeKv: "Active KV",
      average: "average",
      avgInput: "average input",
      running: "running",
      historical: "historical",
      currentRunTokens: "current run tokens",
      currentRunRequests: "current run requests",
      cumulative: "cumulative",
      tokens: "tokens",
      requests: "requests",
      clientsEmpty: "No client usage yet.",
      clientsNote: "Claude statistics include only requests through the Claude-compatible bridge.",
      clientTokens: "Tokens",
      clientRequests: "Requests",
      clientTools: "Tools",
      clientCompression: "Context compression",
      clientLatency: "Average latency",
      input: "input",
      output: "output",
      success: "success",
      error: "errors",
      schemas: "schemas",
      streamed: "streamed",
      times: "times",
      saved: "tokens saved",
      last: "last",
      noLast: "No recent call",
      modelSeparator: ": ",
      modelRequests: "requests",
      sessionTask: "Current Claude task",
      sessionLabel: "session",
      sessionSourceFallback: "auto",
      sessionSwitches: "switches",
      sessionAutoClean: "auto-cleaned",
      sessionRecent: "recent",
      sessionWaiting: "Waiting for Claude task requests",
      sessionDefaultTask: "Claude task",
      sourcesEmpty: "No gateway calls in the last hour.",
      sourcesNote: "Grouped from gateway metadata in the last hour; prompts and responses are not stored.",
      sourceRequests: "Requests",
      sourceTokens: "Tokens",
      sourceLatency: "Average latency",
      sourceResult: "Result",
      sourcePath: "Main path",
      sourceModel: "Main model",
      sourceRemote: "Remote",
      sourceUserAgent: "User-Agent",
      separator: " / ",
      detailSeparator: " - ",
      ...(options?.labels || {}),
    };
  }

  function renderModels(stats, options = {}) {
    const root = options.root || document.querySelector(options.rootSelector || "#statsModelList");
    if (!root) return;
    const labels = getLabels(options);
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const miniStat = helper(options, "miniStat", () => "");
    const shareBar = helper(options, "shareBar", () => "");
    const fmtPct = helper(options, "fmtPct", (value) => `${(Number(value || 0) * 100).toFixed(1)}%`);
    const fmtTokens = helper(options, "fmtTokens", (value) => String(value ?? 0));
    const fmtRate = helper(options, "fmtRate", (value, unit = "") => `${Number(value || 0).toFixed(2)}${unit}`);
    const formatContextUsage = helper(options, "formatContextUsage", () => "-");
    const liveModelsByName = stats.live?.modelsByName || Object.fromEntries((stats.live?.models || []).map((model) => [model.name, model]));
    const models = [...(stats.models || [])].sort((left, right) => {
      const liveDelta = Number(Boolean(liveModelsByName[right.name])) - Number(Boolean(liveModelsByName[left.name]));
      return liveDelta || Number(right.tokens?.total || 0) - Number(left.tokens?.total || 0);
    });
    if (!models.length) {
      root.innerHTML = `<div class="empty compact">${escapeHtml(labels.modelEmpty)}</div>`;
      return;
    }
    const totalTokens = Math.max(1, Number(stats.totals?.tokens?.total || 0));
    const totalRequests = Math.max(1, Number(stats.totals?.requests?.total || 0));
    root.innerHTML = models.map((model) => {
      const liveModel = liveModelsByName[model.name] || null;
      const runtimeModel = liveModel || model;
      const liveTokenTotal = Math.max(1, Number(stats.live?.totals?.tokens?.total || liveModel?.tokens?.total || 0));
      const liveRequestTotal = Math.max(1, Number(stats.live?.totals?.requests?.total || liveModel?.requests?.total || 0));
      const tokenShare = Number((liveModel || model).tokens?.total || 0) / (liveModel ? liveTokenTotal : totalTokens);
      const requestShare = Number((liveModel || model).requests?.total || 0) / (liveModel ? liveRequestTotal : totalRequests);
      const liveContext = Boolean(liveModel);
      const rowClass = options.showRuntimeState ? (liveContext ? "is-live" : "is-inactive") : "";
      const stateLabel = liveContext ? labels.running : labels.historical;
      const title = options.showRuntimeState
        ? `<h4><span>${escapeHtml(model.name)}</span><em class="runtime-state">${escapeHtml(stateLabel)}</em></h4>`
        : `<h4>${escapeHtml(model.name)}</h4>`;
      return `
        <article class="stats-model-row ${rowClass}">
          <div>
            ${title}
            <p>${escapeHtml(model.root || labels.modelFallbackRoot)}</p>
            <div class="stats-row-grid">
              ${liveModel
                ? miniStat(labels.currentRunTokens, fmtTokens(liveModel.tokens?.total || 0), `${labels.cumulative} ${fmtTokens(model.tokens?.total || 0)} ${labels.tokens}`)
                : miniStat(labels.tokenShare, fmtPct(tokenShare), `${fmtTokens(model.tokens?.total || 0)} ${labels.tokens}`)}
              ${liveModel
                ? miniStat(labels.currentRunRequests, fmtTokens(liveModel.requests?.total || 0), `${labels.cumulative} ${fmtTokens(model.requests?.total || 0)} ${labels.requests}`)
                : miniStat(labels.requestShare, fmtPct(requestShare), `${fmtTokens(model.requests?.total || 0)} ${labels.requests}`)}
              ${miniStat(labels.outputSpeed, fmtRate(runtimeModel.speed?.recentOutputTokensPerSecond, " tok/s"), `${labels.average} ${fmtRate(runtimeModel.speed?.averageOutputTokensPerSecond, " tok/s")}`)}
              ${miniStat(labels.activeKv, formatContextUsage(runtimeModel.context?.activeTokens, runtimeModel.context?.capacityTokens, runtimeModel.context?.kvUsagePercent), `${labels.avgInput} ${fmtTokens(runtimeModel.averages?.promptTokensPerRequest || 0)} ${labels.tokens}`)}
            </div>
            ${shareBar("tokens", tokenShare)}
            ${shareBar("requests", requestShare)}
          </div>
        </article>
      `;
    }).join("");
  }

  function renderClients(stats, options = {}) {
    const root = options.root || document.querySelector(options.rootSelector || "#statsClientBreakdown");
    if (!root) return;
    const labels = getLabels(options);
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const usage = stats.clientUsage || {};
    const clients = usage.clients || [];
    if (!clients.length) {
      root.innerHTML = `<div class="empty compact">${escapeHtml(labels.clientsEmpty)}</div>`;
      return;
    }
    root.innerHTML = `
      ${clients.map((client) => renderClientRow(client, options)).join("")}
      <div class="stats-source-note">${escapeHtml(usage.note || labels.clientsNote)}</div>
    `;
  }

  function renderClientRow(client, options = {}) {
    const labels = getLabels(options);
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const miniStat = helper(options, "miniStat", () => "");
    const shareBar = helper(options, "shareBar", () => "");
    const fmtTokens = helper(options, "fmtTokens", (value) => String(value ?? 0));
    const fmtMs = helper(options, "fmtMs", (value) => String(value ?? "-"));
    const formatDateTime = helper(options, "formatDateTime", (value) => String(value || ""));
    const tokens = client.tokens || {};
    const requests = client.requests || {};
    const tools = client.tools || {};
    const compression = client.compression || {};
    const latency = client.latency || {};
    const share = client.share || {};
    const last = client.last || {};
    const lastAt = last.at || last.updatedAt;
    const modelLine = renderClientModelLine(client, options);
    const sessionLine = options.showSessions ? renderClientSessionLine(client, options) : "";
    return `
      <article class="stats-model-row">
        <div>
          <h4>${escapeHtml(client.label || client.id || "-")}</h4>
          <p>${escapeHtml(client.description || "")}</p>
          <div class="stats-row-grid">
            ${miniStat(labels.clientTokens, fmtTokens(tokens.total), `${fmtTokens(tokens.prompt)} ${labels.input} ${labels.detailSeparator}${fmtTokens(tokens.generation)} ${labels.output}`)}
            ${miniStat(labels.clientRequests, fmtTokens(requests.total), `${fmtTokens(requests.success)} ${labels.success} ${labels.detailSeparator}${fmtTokens(requests.error)} ${labels.error}`)}
            ${miniStat(labels.clientTools, fmtTokens(tools.toolUse), `${fmtTokens(tools.schemas)} ${labels.schemas} ${labels.detailSeparator}${fmtTokens(requests.streamed)} ${labels.streamed}`)}
            ${miniStat(labels.clientCompression, fmtTokens(compression.savedTokens || 0), `${fmtTokens(compression.applied || 0)} ${labels.times} ${labels.detailSeparator}${labels.saved}`)}
            ${miniStat(labels.clientLatency, fmtMs(latency.avgMs), lastAt ? `${labels.last} ${formatDateTime(lastAt)}` : labels.noLast)}
          </div>
          ${sessionLine}
          ${modelLine}
          ${shareBar("tokens", share.tokens || 0)}
          ${shareBar("requests", share.requests || 0)}
        </div>
      </article>
    `;
  }

  function renderClientSessionLine(client, options = {}) {
    const labels = getLabels(options);
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const fmtTokens = helper(options, "fmtTokens", (value) => String(value ?? 0));
    const formatDateTime = helper(options, "formatDateTime", (value) => String(value || ""));
    const session = client.session || {};
    const sessions = Array.isArray(client.sessions) ? client.sessions : [];
    if (!session.currentId && !sessions.length) return "";
    const currentId = String(session.currentId || "");
    const shortId = currentId.replace(/^claude-/, "").slice(0, 12) || "-";
    const current = sessions.find((item) => item.id === currentId) || sessions[0] || {};
    const recent = sessions.slice(0, 4);
    const detail = session.contextClearedAt
      ? `${labels.sessionAutoClean} ${fmtTokens(session.resets || 0)} ${labels.times}${labels.separator}${labels.sessionRecent} ${formatDateTime(session.contextClearedAt)}`
      : labels.sessionWaiting;
    return `
      <div class="client-session-panel">
        <div>
          <span>${escapeHtml(labels.sessionTask)}</span>
          <strong>${escapeHtml(current.label || session.currentLabel || shortId)}</strong>
          <small>${escapeHtml(`${labels.sessionLabel} ${shortId}${labels.separator}${session.currentSource || current.source || labels.sessionSourceFallback}${labels.separator}${labels.sessionSwitches} ${fmtTokens(session.switches || 0)} ${labels.times}`)}</small>
          <small>${escapeHtml(detail)}</small>
        </div>
        ${recent.length ? `
          <div class="client-session-list">
            ${recent.map((item) => `
              <span>${escapeHtml(item.label || item.id || labels.sessionDefaultTask)}${escapeHtml(labels.modelSeparator)}${fmtTokens(item.tokens?.total || 0)} ${labels.tokens} / ${fmtTokens(item.requests?.total || 0)} ${labels.modelRequests}</span>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  function renderClientModelLine(client, options = {}) {
    const labels = getLabels(options);
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const fmtTokens = helper(options, "fmtTokens", (value) => String(value ?? 0));
    const models = (client.models || []).slice(0, 3);
    if (!models.length) return "";
    return `
      <div class="client-model-breakdown">
        ${models.map((model) => `
          <span>${escapeHtml(model.name)}${escapeHtml(labels.modelSeparator)}${fmtTokens(model.tokens?.total || 0)} ${labels.tokens} / ${fmtTokens(model.requests?.total || 0)} ${labels.modelRequests}</span>
        `).join("")}
      </div>
    `;
  }

  function renderSourcePrograms(stats, options = {}) {
    const root = options.root || document.querySelector(options.rootSelector || "#statsSourcePrograms");
    if (!root) return;
    const labels = getLabels(options);
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const usage = stats.recentAccess || {};
    const sources = usage.sources || [];
    if (!sources.length) {
      root.innerHTML = `<div class="empty compact">${escapeHtml(labels.sourcesEmpty)}</div>`;
      return;
    }
    const totalRequests = Math.max(1, Number(usage.totals?.requests?.total || sources.reduce((sum, item) => sum + Number(item.count || 0), 0)));
    const formatDateTime = helper(options, "formatDateTime", (value) => String(value || ""));
    root.innerHTML = `
      ${sources.map((source) => renderSourceProgramRow(source, {
        ...options,
        labels,
        totalRequests,
      })).join("")}
      <div class="stats-source-note">${escapeHtml(usage.privacy || labels.sourcesNote)}${usage.startAt ? ` ${escapeHtml(formatDateTime(usage.startAt))} - ${escapeHtml(formatDateTime(usage.endAt))}` : ""}</div>
    `;
  }

  function renderSourceProgramRow(source, options = {}) {
    const labels = getLabels(options);
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const miniStat = helper(options, "miniStat", () => "");
    const shareBar = helper(options, "shareBar", () => "");
    const fmtTokens = helper(options, "fmtTokens", (value) => String(value ?? 0));
    const fmtMs = helper(options, "fmtMs", (value) => String(value ?? "-"));
    const formatDateTime = helper(options, "formatDateTime", (value) => String(value || ""));
    const totalRequests = Math.max(1, Number(options.totalRequests || source.count || 1));
    const requestShare = Number(source.count || 0) / totalRequests;
    const topPath = Array.isArray(source.topPath) ? source.topPath[0] : "";
    const topModel = Array.isArray(source.topModel) ? source.topModel[0] : "";
    const topRemote = Array.isArray(source.topRemoteAddress) ? source.topRemoteAddress[0] : "";
    const topUserAgent = Array.isArray(source.topUserAgent) ? source.topUserAgent[0] : "";
    const remote = topRemote || Object.keys(source.remoteAddresses || {})[0] || "-";
    const userAgent = topUserAgent && topUserAgent !== "none" ? topUserAgent : "";
    const detailLine = [
      topPath && `${labels.sourcePath}${labels.modelSeparator}${topPath}`,
      topModel && topModel !== "-" && `${labels.sourceModel}${labels.modelSeparator}${topModel}`,
      remote && `${labels.sourceRemote}${labels.modelSeparator}${remote}`,
    ].filter(Boolean).join(labels.separator);
    return `
      <article class="stats-model-row">
        <div>
          <h4>${escapeHtml(source.label || source.key || "-")}</h4>
          <p>${escapeHtml(userAgent || detailLine || "")}</p>
          <div class="stats-row-grid">
            ${miniStat(labels.sourceRequests, fmtTokens(source.count || 0), `${fmtTokens(source.success || 0)} ${labels.success}${labels.detailSeparator}${fmtTokens(source.error || 0)} ${labels.error}`)}
            ${miniStat(labels.sourceTokens, fmtTokens(source.totalTokens || 0), `${fmtTokens(source.inputTokens || 0)} ${labels.input}${labels.detailSeparator}${fmtTokens(source.outputTokens || 0)} ${labels.output}`)}
            ${miniStat(labels.sourceLatency, fmtMs(source.avgDurationMs || 0), `${labels.last} ${formatDateTime(source.lastAt)}`)}
            ${miniStat(labels.sourceResult, `${(Number(source.errorRate || 0) * 100).toFixed(1)}%`, labels.error)}
          </div>
          ${detailLine ? `<div class="client-model-breakdown"><span>${escapeHtml(detailLine)}</span></div>` : ""}
          ${shareBar("requests", requestShare)}
        </div>
      </article>
    `;
  }

  function create(defaults = {}) {
    const withDefaults = (options = {}) => ({ ...defaults, ...options, labels: { ...(defaults.labels || {}), ...(options.labels || {}) } });
    return {
      renderModels: (stats, options) => renderModels(stats, withDefaults(options)),
      renderClients: (stats, options) => renderClients(stats, withDefaults(options)),
      renderClientRow: (client, options) => renderClientRow(client, withDefaults(options)),
      renderClientSessionLine: (client, options) => renderClientSessionLine(client, withDefaults(options)),
      renderClientModelLine: (client, options) => renderClientModelLine(client, withDefaults(options)),
      renderSourcePrograms: (stats, options) => renderSourcePrograms(stats, withDefaults(options)),
      renderSourceProgramRow: (source, options) => renderSourceProgramRow(source, withDefaults(options)),
    };
  }

  const api = {
    create,
    renderModels,
    renderClients,
    renderClientRow,
    renderClientSessionLine,
    renderClientModelLine,
    renderSourcePrograms,
    renderSourceProgramRow,
  };
  window.LocalAiStatsListRenderer = api;
  window.statsListRenderer = api;
}());
