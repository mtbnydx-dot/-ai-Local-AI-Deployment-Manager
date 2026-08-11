(function () {
  // Canonical renderer shared by both managers. Authentication state always
  // comes from the server's authoritative gatewayApiKeyEnforced field.
  function create(deps = {}) {
    const {
      $,
      state,
      escapeHtml,
      escapeAttr,
      fmtTokens,
      defaultServicePort,
      includeOpenCode = false,
    } = deps;

    function renderServiceExposure() {
      const payload = state.serviceExposure;
      if (!payload) return;
      const settings = payload.settings || {};
      fillExposureForm(settings);
      const keyState = $("#exposureApiKeyState");
      const activeClients = Number(payload.actual?.service?.clients?.active || 0);
      if (keyState) {
        keyState.textContent = settings.hasApiKey
          ? `全局 Key 已保存：${settings.apiKeyPreview}`
          : activeClients
            ? `未保存全局 Key；已有 ${activeClients} 个客户端 Key 可用`
            : "未保存全局 Key";
      }
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
      setValue("#exposureCorsMode", settings.corsMode || ((settings.allowedOrigins || []).length ? "restricted" : "open"));
      setValue("#exposureRateLimitRpm", settings.rateLimitRpm || 120);
      setValue("#exposureMaxConcurrentRequests", settings.maxConcurrentRequests || 4);
      setValue("#exposureMaxQueuedRequests", settings.maxQueuedRequests ?? 128);
      setValue("#exposureQueueTimeoutSeconds", settings.queueTimeoutSeconds || 30);
      setValue("#exposureRequestTimeoutSeconds", settings.requestTimeoutSeconds || 600);
      setValue("#exposureAllowedOrigins", (settings.allowedOrigins || []).join("\n"));
      setValue("#exposureAllowedHeaders", (settings.allowedHeaders || []).join("\n"));
      setChecked("#exposureOpenAI", settings.exposeOpenAI !== false);
      setChecked("#exposureClaude", settings.exposeClaude !== false);
      setChecked("#exposureOpenCode", settings.exposeOpenCode !== false);
      setChecked("#exposureMetrics", Boolean(settings.exposeMetrics));
      setChecked("#exposureAllowManagerRemote", Boolean(settings.allowManagerRemote));
      setValue("#exposureNotes", settings.notes || "");
      setValue("#exposureApiKey", "");
    }

    // 公网地址优先取表单里未保存的输入，让预览即时跟随；留空再回落到已保存设置
    function effectivePublicBaseUrl(settings) {
      const draft = String($("#exposurePublicBaseUrl")?.value || "").trim().replace(/\/$/, "");
      return draft || String(settings.publicBaseUrl || "").trim().replace(/\/$/, "");
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
      const publicBase = effectivePublicBaseUrl(settings);
      const publicOpenAi = publicBase ? `${publicBase}/serve/v1` : "";
      const publicClaude = publicBase ? `${publicBase}/claude` : "";
      const publicClaudeMessages = publicBase ? `${publicBase}/claude/v1/messages` : "";
      const openAiClientBase = service.openAiGatewayLanBaseUrl || service.openAiGatewayLocalBaseUrl || "-";
      const openAiLocalGateway = service.openAiGatewayLocalBaseUrl || "-";
      const claudeClientBase = selectedMode === "reverse-proxy"
        ? service.claudePublicBaseUrl || service.claudeLanBaseUrl || service.claudeLocalBaseUrl || "-"
        : service.claudeLanBaseUrl || service.claudePublicBaseUrl || service.claudeLocalBaseUrl || "-";
      const claudeMessagesUrl = service.claudeLanMessagesUrl || service.claudeLocalMessagesUrl || "-";
      const gatewayEnabled = settings.enabled !== false;
      const openAiEnabled = gatewayEnabled && settings.exposeOpenAI !== false;
      const claudeEnabled = gatewayEnabled && settings.exposeClaude !== false;
      const openCodeEnabled = gatewayEnabled && settings.exposeOpenCode !== false;
      root.innerHTML = `
        ${exposureLiveControls(settings, includeOpenCode)}
        ${selectedMode === "reverse-proxy" ? renderPublicGuide(settings, service, publicBase) : ""}
        ${publicOpenAi && selectedMode === "reverse-proxy" ? exposureEndpointCard("OpenAI 公网网关（推荐）", publicOpenAi, `${openAiEnabled ? "当前已开放。" : "当前已关闭。"}公网客户端统一用这个地址：Caddy 终止 TLS 后代理到管理器 /serve/v1，鉴权、限流、排队、审计都在这里生效。`, openAiEnabled ? "recommended" : "disabled", endpointToggleAction(gatewayEnabled ? "exposeOpenAI" : "enabled", true, openAiEnabled ? "关闭 OpenAI" : gatewayEnabled ? "开启 OpenAI" : "开启总开关", openAiEnabled)) : ""}
        ${publicClaude && selectedMode === "reverse-proxy" ? exposureEndpointCard("Claude 公网网关（推荐）", publicClaude, `${claudeEnabled ? "当前已开放。" : "当前已关闭。"}Claude Desktop / Cowork / ccswitch 的 Base URL；认证字段用 ANTHROPIC_API_KEY 或 Bearer Token。完整 messages 地址：${publicClaudeMessages}`, claudeEnabled ? "recommended" : "disabled", endpointToggleAction(gatewayEnabled ? "exposeClaude" : "enabled", true, claudeEnabled ? "关闭 Claude" : gatewayEnabled ? "开启 Claude" : "开启总开关", claudeEnabled)) : ""}
        ${exposureEndpointCard(selectedMode === "reverse-proxy" ? "OpenAI 内网网关" : "Chatbox / OpenWebUI / OpenAI SDK", openAiClientBase, selectedMode === "reverse-proxy" ? "只给本机/内网客户端；公网客户端请用上面的公网网关地址。" : `${openAiEnabled ? "当前已开放。" : "当前已关闭。"}Provider 选 OpenAI Compatible；Base URL 必须以 /serve/v1 结尾。只有该网关入口会执行队列、限流与审计；直连容器端口不会排队。`, selectedMode === "reverse-proxy" ? "" : openAiEnabled ? "recommended" : "disabled", selectedMode === "reverse-proxy" ? "" : endpointToggleAction(gatewayEnabled ? "exposeOpenAI" : "enabled", true, openAiEnabled ? "关闭 OpenAI" : gatewayEnabled ? "开启 OpenAI" : "开启总开关", openAiEnabled))}
        ${openAiLocalGateway !== openAiClientBase ? exposureEndpointCard("OpenAI 本机网关", openAiLocalGateway, "本机客户端使用；同样走鉴权、限流、并发、审计。") : ""}
        ${exposureEndpointCard("Claude / Cowork / CC Switch", claudeClientBase, `${claudeEnabled ? "当前已开放。" : "当前已关闭。"}Provider 选 Anthropic / Claude；Base URL 填 /claude，认证字段用 ANTHROPIC_API_KEY 或 Bearer Token。`, claudeEnabled ? "recommended" : "disabled", endpointToggleAction(gatewayEnabled ? "exposeClaude" : "enabled", true, claudeEnabled ? "关闭 Claude" : gatewayEnabled ? "开启 Claude" : "开启总开关", claudeEnabled))}
        ${exposureEndpointCard("Claude messages 完整 URL", claudeMessagesUrl, "只有客户端明确要求完整 messages endpoint 时才填；一般不要手动追加 /v1/messages。", claudeEnabled ? "" : "disabled")}
        ${exposureEndpointCard("仅调试：OpenAI 容器直连", service.openAiLocalBaseUrl || "-", "本机排错用；不经过管理器的客户端 Key、限流、并发和审计，不建议给 Chatbox/OpenWebUI。", "debug")}
        ${service.openAiLanBaseUrl ? exposureEndpointCard(selectedMode === "reverse-proxy" ? "风险：容器端口已发布到内网" : "仅调试：容器局域网直连", service.openAiLanBaseUrl, selectedMode === "reverse-proxy" ? `Docker 已把容器转发到 ${service.lanHost || "内网地址"}；公网部署不要把容器端口暴露到任何网卡，请改回本机绑定并重启模型。` : `Docker 已转发到 ${service.lanHost || "本机局域网 IP"}；外部服务优先使用 /serve/v1 网关。`, "debug") : ""}
        ${plannedOpenAiLan ? exposureEndpointCard("容器局域网直连（下次启动）", plannedOpenAiLan, "保存并按局域网模式启动/重启模型后才会生效；外部客户端仍优先使用 /serve/v1。", "debug") : ""}
        ${includeOpenCode ? exposureEndpointCard("OpenCode", service.openCodeBaseUrl || "-", `${openCodeEnabled ? "当前已开放。" : "当前已关闭。"}模型名可用 local-current。`, openCodeEnabled ? "" : "disabled", endpointToggleAction(gatewayEnabled ? "exposeOpenCode" : "enabled", true, openCodeEnabled ? "关闭 OpenCode" : gatewayEnabled ? "开启 OpenCode" : "开启总开关", openCodeEnabled)) : ""}
        ${exposureEndpointCard("Manager", manager.localBaseUrl || "-", manager.remoteManagementAllowed ? "管理器允许远程访问；公网部署请不要反代该地址。" : "管理器仅建议本机访问；公网部署不要反代该地址。")}
        <div class="exposure-runtime-summary">
          <span>状态：${escapeHtml(service.running ? service.containerStatus || "运行中" : "未运行")}</span>
          <span>模型：${escapeHtml((service.modelIds || []).join(", ") || "-")}</span>
          <span>上下文：${service.maxModelLen ? fmtTokens(service.maxModelLen) : "-"}</span>
          <span>客户端 Key：${fmtTokens(service.clients?.active || 0)} / ${fmtTokens(service.clients?.total || 0)}</span>
          <span>网关鉴权：${escapeHtml(gatewayAuthSummary(service, settings))}</span>
          <span>请求队列：并发 ${fmtTokens(settings.maxConcurrentRequests || 0)} · 等待 ${fmtTokens(settings.maxQueuedRequests || 0)} · ${fmtTokens(settings.queueTimeoutSeconds || 0)}s</span>
          <span>容器鉴权：${escapeHtml(runtimeAuthSummary(service))}</span>
        </div>
      `;
    }

    // 公网/反代模式的部署清单：让用户在保存设置后知道每一步还差什么
    function renderPublicGuide(settings, service, publicBase) {
      const publicHttps = /^https:\/\//i.test(publicBase);
      // Use the server's verdict rather than recomputing it here, so a config
      // that failed to load cannot read as "key configured".
      const hasKey = Boolean(service.gatewayApiKeyEnforced);
      const lanPublished = Boolean(service.openAiLanBaseUrl);
      const steps = [
        {
          ok: Boolean(publicBase),
          title: "1. 域名与 DNS",
          detail: publicBase
            ? `公网 Base URL：${publicBase}。把该域名的 A 记录指向本机公网 IP；OpenWebUI 建议单独子域。`
            : "先在左侧表单填公网 Base URL（必须 https://），并把域名 A 记录指向本机公网 IP。",
        },
        {
          ok: publicBase && publicHttps,
          title: "2. TLS 终止",
          detail: publicBase && publicHttps
            ? "用 deploy/public/Caddyfile 由 Caddy 自动签发证书；公网只应代理 /gateway/* 与 OpenWebUI，管理后台与容器端口不进反代。"
            : "公网地址必须是 https://；用 deploy/public/Caddyfile 由 Caddy 自动签发，不要直接暴露管理器或容器 HTTP 端口。",
        },
        {
          ok: hasKey,
          title: "3. 网关鉴权",
          detail: hasKey
            ? "已要求 API Key；公网客户端建议使用下方独立客户端 Key（可分模型、限速、设过期），全局 Key 只留作应急。"
            : "勾选“对外访问必须使用 API Key”并配置全局 Key 或创建客户端 Key；公网无 Key 等于开放算力。",
        },
        {
          ok: !lanPublished,
          title: "4. 端口与防火墙",
          detail: lanPublished
            ? `检测到容器端口已发布到 ${service.lanHost || "内网"}；公网机器上应改回本机绑定并重启模型。防火墙只放行 80/443（80 用于 Caddy 证书签发），3000/5176/5177/5178/8000/8080 保持回环。`
            : "防火墙/安全组只放行 80/443（80 用于 Caddy 证书签发）；3000/5176/5177/5178/8000/8080 保持回环。",
        },
        {
          ok: true,
          title: "5. 管理后台不上公网",
          detail: "两个管理器和统一入口控制台只走回环访问；公网反代只放行 /gateway/* 路径，不要把本页地址暴露出去。",
        },
      ];
      return `
        <section class="exposure-public-guide">
          <div class="exposure-public-guide-head">
            <strong>公网部署清单</strong>
            <span>按顺序完成；状态会随表单与已保存设置即时更新。</span>
          </div>
          ${steps.map((step) => `
            <div class="exposure-guide-step ${step.ok ? "ok" : "todo"}">
              <span class="tool-status-dot"></span>
              <div><strong>${escapeHtml(step.title)}</strong><small>${escapeHtml(step.detail)}</small></div>
            </div>
          `).join("")}
        </section>
      `;
    }

    function gatewayAuthSummary(service, settings) {
      if (!settings.requireApiKey) return "未强制";
      if (service.gatewayApiKeyEnforced) {
        const parts = [];
        if (service.gatewayHasGlobalApiKey) parts.push("全局 Key");
        if (Number(service.clients?.active || 0)) parts.push(`${service.clients.active} 个客户端 Key`);
        return `已强制（${parts.join(" + ") || "已配置"}）`;
      }
      return "已要求但未配置 Key";
    }

    function runtimeAuthSummary(service) {
      return service.runtimeApiKeyRequired || service.apiKeyRequired ? "容器已启用" : "容器未启用";
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
        exposureModeButton("公网", "reverse-proxy", mode === "reverse-proxy"),
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
      const copyable = value && value !== "-";
      return `
        <article class="exposure-endpoint-card ${escapeAttr(kind)}">
          <div class="exposure-endpoint-head">
            <span>${escapeHtml(title)}</span>
            <span class="exposure-endpoint-actions">
              ${copyable ? `<button class="ghost-mini-button exposure-card-action" type="button" data-exposure-action="copy" data-exposure-copy="${escapeAttr(value)}" title="复制地址">复制</button>` : ""}
              ${actionHtml || ""}
            </span>
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
