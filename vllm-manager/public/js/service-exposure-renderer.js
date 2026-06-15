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
      root.innerHTML = `
        ${exposureEndpointCard("OpenAI 网关（推荐）", service.openAiGatewayLocalBaseUrl || "-", "鉴权、限流、并发和超时都在这里执行；模型名可用 local-current")}
        ${service.openAiGatewayLanBaseUrl ? exposureEndpointCard("OpenAI 网关局域网", service.openAiGatewayLanBaseUrl, "局域网设备优先使用这个地址") : ""}
        ${publicOpenAi ? exposureEndpointCard("OpenAI 网关公网", publicOpenAi, "反向代理后提供给外部客户端") : ""}
        ${exposureEndpointCard("OpenAI 直连容器", service.openAiLocalBaseUrl || "-", "本机调试用；不经过管理器网关限流")}
        ${service.openAiLanBaseUrl ? exposureEndpointCard("OpenAI 容器局域网", service.openAiLanBaseUrl, `Docker 已把容器端口转发到 ${service.lanHost || "本机局域网 IP"}；直连容器端口，外部使用前需确认容器自身或反向代理鉴权`) : ""}
        ${plannedOpenAiLan ? exposureEndpointCard("OpenAI 容器局域网（下次启动）", plannedOpenAiLan, "保存并按局域网模式启动/重启模型后，Docker 会把容器端口转发到这个本机 IP。") : ""}
        ${settings.exposeClaude !== false ? exposureEndpointCard("Claude 桥", service.claudeLocalMessagesUrl || "-", "Claude Desktop / Cowork / Claude Code") : ""}
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

    function exposureEndpointCard(title, value, detail) {
      return `
        <article class="exposure-endpoint-card">
          <span>${escapeHtml(title)}</span>
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
