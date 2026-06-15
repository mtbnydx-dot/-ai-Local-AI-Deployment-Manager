(function () {
  function create(deps = {}) {
    const {
      $,
      state,
      escapeHtml,
      escapeAttr,
      fmtTokens,
      defaultServicePort,
      includeOpenCode = false,
      apiKeySummary = (service) => (service.apiKeyRequired ? "运行中已启用" : "运行中未启用"),
    } = deps;

    function renderServiceExposure() {
      const payload = state.serviceExposure;
      if (!payload) return;
      const settings = payload.settings || {};
      fillExposureForm(settings);
      const keyState = $("#exposureApiKeyState");
      if (keyState) keyState.textContent = settings.hasApiKey ? `已保存：${settings.apiKeyPreview}` : "未保存密钥";
      renderServiceExposureEndpoints(payload);
      renderServiceExposureChecks(payload);
    }

    function fillExposureForm(settings) {
      const form = $("#serviceExposureForm");
      if (!form || form.matches(":focus-within")) return;
      setChecked("#exposureEnabled", Boolean(settings.enabled));
      setValue("#exposureMode", settings.exposureMode || "local");
      setChecked("#exposureRequireApiKey", Boolean(settings.requireApiKey));
      setChecked("#exposureClearApiKey", false);
      setValue("#exposurePublicBaseUrl", settings.publicBaseUrl || "");
      setValue("#exposureRateLimitRpm", settings.rateLimitRpm || 120);
      setValue("#exposureMaxConcurrentRequests", settings.maxConcurrentRequests || 4);
      setValue("#exposureRequestTimeoutSeconds", settings.requestTimeoutSeconds || 600);
      setValue("#exposureAllowedOrigins", (settings.allowedOrigins || []).join("\n"));
      setChecked("#exposureOpenAI", settings.exposeOpenAI !== false);
      setChecked("#exposureClaude", settings.exposeClaude !== false);
      setChecked("#exposureOpenCode", settings.exposeOpenCode !== false);
      setChecked("#exposureMetrics", Boolean(settings.exposeMetrics));
      setChecked("#exposureAllowManagerRemote", Boolean(settings.allowManagerRemote));
      setValue("#exposureNotes", settings.notes || "");
      setValue("#exposureApiKey", "");
    }

    function renderServiceExposureEndpoints(payload) {
      const root = $("#serviceExposureEndpoints");
      if (!root || !payload) return;
      const actual = payload.actual || {};
      const service = actual.service || {};
      const manager = actual.manager || {};
      const settings = payload.settings || {};
      const selectedMode = $("#exposureMode")?.value || settings.exposureMode || "local";
      const lanAddress = state.config?.lanAddress || service.lanHost || "127.0.0.1";
      const servicePort = Number(service.port || state.config?.defaultPort || defaultServicePort);
      const plannedOpenAiLan = selectedMode === "lan" && !service.openAiLanBaseUrl
        ? `http://${lanAddress}:${servicePort}/v1`
        : "";
      const publicOpenAi = settings.publicBaseUrl ? `${settings.publicBaseUrl.replace(/\/$/, "")}/serve/v1` : "";
      const openAiClientBase = service.openAiGatewayLanBaseUrl || service.openAiGatewayLocalBaseUrl || "-";
      const openAiLocalGateway = service.openAiGatewayLocalBaseUrl || "-";
      const claudeClientBase = service.claudeLanBaseUrl || service.claudePublicBaseUrl || service.claudeLocalBaseUrl || "-";
      const claudeMessagesUrl = service.claudeLanMessagesUrl || service.claudeLocalMessagesUrl || "-";
      const gatewayEnabled = settings.enabled !== false;
      const openAiEnabled = gatewayEnabled && settings.exposeOpenAI !== false;
      const claudeEnabled = gatewayEnabled && settings.exposeClaude !== false;
      root.innerHTML = `
        ${exposureLiveControls(settings, includeOpenCode)}
        ${exposureEndpointCard("Chatbox / OpenWebUI / OpenAI SDK", openAiClientBase, `${openAiEnabled ? "当前已开放。" : "当前已关闭。"}Provider 选 OpenAI Compatible；Base URL 必须以 /serve/v1 结尾，API Key 填客户端 Key / Bearer Token，不要填 /claude。`, openAiEnabled ? "recommended" : "disabled", endpointToggleAction(gatewayEnabled ? "exposeOpenAI" : "enabled", true, openAiEnabled ? "关闭 OpenAI" : gatewayEnabled ? "开启 OpenAI" : "开启总开关", openAiEnabled))}
        ${openAiLocalGateway !== openAiClientBase ? exposureEndpointCard("OpenAI 本机网关", openAiLocalGateway, "本机客户端使用；同样走鉴权、限流、并发、审计。") : ""}
        ${publicOpenAi ? exposureEndpointCard("OpenAI 网关公网", publicOpenAi, "反向代理后提供给外部客户端") : ""}
        ${exposureEndpointCard("Claude / Cowork / CC Switch", claudeClientBase, `${claudeEnabled ? "当前已开放。" : "当前已关闭。"}Provider 选 Anthropic / Claude；Base URL 填 /claude，认证字段用 ANTHROPIC_API_KEY 或 Bearer Token。`, claudeEnabled ? "recommended" : "disabled", endpointToggleAction(gatewayEnabled ? "exposeClaude" : "enabled", true, claudeEnabled ? "关闭 Claude" : gatewayEnabled ? "开启 Claude" : "开启总开关", claudeEnabled))}
        ${exposureEndpointCard("Claude messages 完整 URL", claudeMessagesUrl, "只有客户端明确要求完整 messages endpoint 时才填；一般不要手动追加 /v1/messages。", claudeEnabled ? "" : "disabled")}
        ${exposureEndpointCard("仅调试：OpenAI 容器直连", service.openAiLocalBaseUrl || "-", "本机排错用；不经过管理器的客户端 Key、限流、并发和审计，不建议给 Chatbox/OpenWebUI。", "debug")}
        ${service.openAiLanBaseUrl ? exposureEndpointCard("仅调试：容器局域网直连", service.openAiLanBaseUrl, `Docker 已转发到 ${service.lanHost || "本机局域网 IP"}；外部服务优先使用 /serve/v1 网关。`, "debug") : ""}
        ${plannedOpenAiLan ? exposureEndpointCard("容器局域网直连（下次启动）", plannedOpenAiLan, "保存并按局域网模式启动/重启模型后才会生效；外部客户端仍优先使用 /serve/v1。", "debug") : ""}
        ${includeOpenCode && settings.exposeOpenCode !== false ? exposureEndpointCard("OpenCode", service.openCodeBaseUrl || "-", "模型名可用 local-current") : ""}
        ${exposureEndpointCard("Manager", manager.localBaseUrl || "-", manager.remoteManagementAllowed ? "管理器允许远程访问" : "管理器仅建议本机访问")}
        <div class="exposure-runtime-summary">
          <span>状态：${escapeHtml(service.running ? service.containerStatus || "运行中" : "未运行")}</span>
          <span>模型：${escapeHtml((service.modelIds || []).join(", ") || "-")}</span>
          <span>上下文：${service.maxModelLen ? fmtTokens(service.maxModelLen) : "-"}</span>
          <span>客户端 Key：${fmtTokens(service.clients?.active || 0)} / ${fmtTokens(service.clients?.total || 0)}</span>
          <span>API Key：${escapeHtml(apiKeySummary(service))}</span>
        </div>
      `;
    }

    function exposureLiveControls(settings, showOpenCode) {
      const gatewayEnabled = settings.enabled !== false;
      const mode = settings.exposureMode || "local";
      const buttons = [
        exposureControlButton("总开关", "enabled", !gatewayEnabled, gatewayEnabled ? "已开启" : "已关闭", gatewayEnabled),
        exposureControlButton("OpenAI", "exposeOpenAI", settings.exposeOpenAI === false, settings.exposeOpenAI !== false ? "已开放" : "已关闭", settings.exposeOpenAI !== false),
        exposureControlButton("Claude", "exposeClaude", settings.exposeClaude === false, settings.exposeClaude !== false ? "已开放" : "已关闭", settings.exposeClaude !== false),
        showOpenCode ? exposureControlButton("OpenCode", "exposeOpenCode", settings.exposeOpenCode === false, settings.exposeOpenCode !== false ? "已开放" : "已关闭", settings.exposeOpenCode !== false) : "",
        exposureControlButton("API Key", "requireApiKey", !settings.requireApiKey, settings.requireApiKey ? "必填" : "未强制", Boolean(settings.requireApiKey)),
        exposureModeButton("本机", "local", mode === "local"),
        exposureModeButton("局域网", "lan", mode === "lan"),
      ].filter(Boolean).join("");
      return `
        <section class="exposure-live-controls">
          <div>
            <strong>网关即时开关</strong>
            <span>这里会直接修改管理器网关策略，不会重启模型；Docker 容器端口绑定仍在下次启动时应用。</span>
          </div>
          <div class="exposure-control-buttons">${buttons}</div>
        </section>
      `;
    }

    function exposureControlButton(label, field, nextValue, stateText, active) {
      return `
        <button class="exposure-state-button ${active ? "active" : "off"}" type="button" data-exposure-action="set" data-exposure-field="${escapeAttr(field)}" data-exposure-value="${escapeAttr(String(Boolean(nextValue)))}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(stateText)}</strong>
        </button>
      `;
    }

    function exposureModeButton(label, value, active) {
      return `
        <button class="exposure-state-button ${active ? "active" : "off"}" type="button" data-exposure-action="set" data-exposure-field="exposureMode" data-exposure-value="${escapeAttr(value)}">
          <span>模式</span>
          <strong>${escapeHtml(label)}</strong>
        </button>
      `;
    }

    function endpointToggleAction(field, enableValue, enableLabel, currentlyEnabled) {
      const nextValue = currentlyEnabled ? false : enableValue;
      return `
        <button class="ghost-mini-button exposure-card-action" type="button" data-exposure-action="set" data-exposure-field="${escapeAttr(field)}" data-exposure-value="${escapeAttr(String(nextValue))}">
          ${escapeHtml(enableLabel)}
        </button>
      `;
    }

    function exposureEndpointCard(title, value, detail, kind = "", actionHtml = "") {
      return `
        <article class="exposure-endpoint-card ${escapeAttr(kind)}">
          <div class="exposure-endpoint-head">
            <span>${escapeHtml(title)}</span>
            ${actionHtml || ""}
          </div>
          <code>${escapeHtml(value)}</code>
          <small>${escapeHtml(detail || "")}</small>
        </article>
      `;
    }

    function renderServiceExposureChecks(payload) {
      const root = $("#serviceExposureChecks");
      if (!root || !payload) return;
      const checks = payload.checks || [];
      root.innerHTML = checks.length
        ? checks.map((check) => `
          <article class="exposure-check-row ${escapeAttr(check.status || "warn")}">
            <span class="tool-status-dot"></span>
            <div><strong>${escapeHtml(check.title || "")}</strong><small>${escapeHtml(check.detail || "")}</small></div>
          </article>
        `).join("")
        : `<div class="empty compact">暂无检查项。</div>`;
    }

    function setValue(selector, value) {
      const node = $(selector);
      if (node) node.value = value;
    }

    function setChecked(selector, value) {
      const node = $(selector);
      if (node) node.checked = Boolean(value);
    }

    return {
      renderServiceExposure,
      renderServiceExposureChecks,
      renderServiceExposureEndpoints,
    };
  }

  window.LocalAiServiceExposureRenderer = { create };
})();
