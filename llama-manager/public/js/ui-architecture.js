(function () {
  function create(deps = {}) {
    const $ = deps.$ || ((selector) => document.querySelector(selector));
    const escapeHtml = deps.escapeHtml || ((value) => String(value || ""));

    function ensureServiceExposureUi(options = {}) {
      const nav = document.querySelector(".nav");
      if (nav && !nav.querySelector("[data-view='exposure']")) {
        const link = document.createElement("a");
        link.href = "#exposure";
        link.dataset.view = "exposure";
        link.innerHTML = `<i data-lucide="globe-2"></i><span>${escapeHtml(options.navLabel || "对外服务")}</span>`;
        nav.querySelector("[data-view='download']")?.after(link);
      }
      if ($("#exposure")) return;
      const tools = $("#tools");
      const section = document.createElement("section");
      section.className = "service-exposure-page view-panel";
      section.id = "exposure";
      section.dataset.viewPanel = "exposure";
      section.innerHTML = serviceExposureHtml(options);
      tools?.before(section);
    }

    return {
      ensureServiceExposureUi,
    };

    function serviceExposureHtml(options = {}) {
      const includeOpenCode = options.includeOpenCode === true;
      const formNote = options.formNote || "局域网或公网服务建议同时使用 API Key、固定模型别名、日志统计和反向代理限流。保存后如需生效到容器，请点“应用到启动表单”并重启模型。";
      const apiKeyLabel = options.apiKeyLabel || "API Key";
      const clientDescription = options.clientDescription || "给 OpenWebUI、Claude 或局域网设备单独发 Key，并限制模型、速率和并发。";
      return `
        <div class="panel exposure-hero-panel">
          <div>
            <h3>对外提供模型服务</h3>
            <p>集中管理访问范围、鉴权、客户端入口和上线前检查。这里保存的是服务化策略；模型参数仍在“服务”页启动。</p>
          </div>
          <div class="panel-actions">
            <button class="secondary-button compact-button" id="refreshServiceExposureBtn" type="button"><i data-lucide="refresh-cw"></i><span>刷新状态</span></button>
            <button class="secondary-button compact-button" id="applyExposureToLaunchBtn" type="button"><i data-lucide="send"></i><span>应用到启动表单</span></button>
          </div>
        </div>
        <div class="service-exposure-grid">
          <form class="panel exposure-settings-panel" id="serviceExposureForm">
            <div class="panel-head">
              <h3>服务化策略</h3>
              <button class="primary-button compact-button" type="submit"><i data-lucide="save"></i><span>保存</span></button>
            </div>
            <div class="exposure-form-grid">
              <label class="check-row"><input id="exposureEnabled" name="enabled" type="checkbox" /><span>启用服务化配置</span></label>
              <label>
                <span>开放方式</span>
                <select id="exposureMode" name="exposureMode">
                  <option value="local">仅本机客户端</option>
                  <option value="lan">局域网服务</option>
                  <option value="reverse-proxy">公网/反向代理</option>
                </select>
              </label>
              <label class="check-row"><input id="exposureRequireApiKey" name="requireApiKey" type="checkbox" /><span>对外访问必须使用 API Key</span></label>
              <label>
                <span>${escapeHtml(apiKeyLabel)}</span>
                <div class="inline-input-action">
                  <input id="exposureApiKey" name="apiKey" type="password" autocomplete="off" placeholder="留空表示保持现有密钥" />
                  <button class="ghost-mini-button" id="generateExposureApiKey" type="button">生成</button>
                </div>
                <small id="exposureApiKeyState">未保存密钥</small>
              </label>
              <label class="check-row"><input id="exposureClearApiKey" name="clearApiKey" type="checkbox" /><span>清除已保存 API Key</span></label>
              <label><span>公网 Base URL</span><input id="exposurePublicBaseUrl" name="publicBaseUrl" placeholder="https://llm.example.com" /></label>
              <label><span>每分钟请求上限</span><input id="exposureRateLimitRpm" name="rateLimitRpm" type="number" min="1" max="5000" value="120" /></label>
              <label><span>最大并发请求</span><input id="exposureMaxConcurrentRequests" name="maxConcurrentRequests" type="number" min="1" max="256" value="4" /></label>
              <label><span>请求超时秒数</span><input id="exposureRequestTimeoutSeconds" name="requestTimeoutSeconds" type="number" min="10" max="7200" value="600" /></label>
              <label class="wide-field"><span>浏览器允许来源（CORS，可选）</span><textarea id="exposureAllowedOrigins" name="allowedOrigins" rows="3" placeholder="留空=允许任意 Origin；每行一个 http://192.168.1.20:3000 或 https://example.com"></textarea></label>
              <div class="exposure-toggle-grid wide-field">
                <label class="check-row"><input id="exposureOpenAI" name="exposeOpenAI" type="checkbox" /><span>OpenAI 兼容接口</span></label>
                <label class="check-row"><input id="exposureClaude" name="exposeClaude" type="checkbox" /><span>Claude 兼容桥</span></label>
                ${includeOpenCode ? `<label class="check-row"><input id="exposureOpenCode" name="exposeOpenCode" type="checkbox" /><span>OpenCode 代理</span></label>` : ""}
                <label class="check-row"><input id="exposureMetrics" name="exposeMetrics" type="checkbox" /><span>暴露 metrics</span></label>
                <label class="check-row"><input id="exposureAllowManagerRemote" name="allowManagerRemote" type="checkbox" /><span>允许远程管理器桥接</span></label>
              </div>
              <label class="wide-field"><span>运维备注</span><textarea id="exposureNotes" name="notes" rows="3" placeholder="服务对象、端口、防火墙、反代、密钥轮换计划等"></textarea></label>
            </div>
            <div class="form-note">${escapeHtml(formNote)}</div>
          </form>
          <div class="panel exposure-status-panel"><div class="panel-head"><h3>当前入口</h3></div><div class="exposure-endpoints" id="serviceExposureEndpoints"><div class="empty compact">正在读取服务入口...</div></div></div>
          <div class="panel exposure-check-panel"><div class="panel-head"><h3>上线前检查</h3></div><div class="exposure-checks" id="serviceExposureChecks"><div class="empty compact">正在生成检查项...</div></div></div>
          <div class="panel exposure-clients-panel">
            <div class="panel-head">
              <div>
                <h3>客户端 API Key</h3>
                <p>${escapeHtml(clientDescription)}</p>
              </div>
            </div>
            <form class="service-client-form" id="serviceClientForm">
              <input name="name" placeholder="客户端名称，例如 OpenWebUI iPad" />
              <input name="allowedModels" placeholder="允许模型，留空=全部；多个用逗号分隔" />
              <input name="rateLimitRpm" type="number" min="1" max="5000" value="120" title="每分钟请求上限" />
              <input name="maxConcurrentRequests" type="number" min="1" max="256" value="4" title="最大并发" />
              <input name="requestTimeoutSeconds" type="number" min="10" max="7200" value="600" title="超时秒数" />
              <input name="expiresAt" type="datetime-local" title="过期时间，可留空" />
              <textarea name="notes" rows="2" placeholder="备注"></textarea>
              <button class="primary-button compact-button" type="submit"><i data-lucide="key-round"></i><span>创建 Key</span></button>
            </form>
            <div class="service-client-secret" id="serviceClientSecret" hidden></div>
            <div class="service-client-list" id="serviceClientList"><div class="empty compact">暂无客户端 Key。</div></div>
          </div>
        </div>
      `;
    }
  }

  window.LocalAiUiArchitecture = { create };
})();
