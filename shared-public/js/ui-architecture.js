(function () {
  function create(deps = {}) {
    const $ = deps.$ || ((selector) => document.querySelector(selector));
    const escapeHtml = deps.escapeHtml
      || window.LocalAiDomUtils?.escapeHtml
      || ((value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;"));

    function ensureServiceExposureUi(options = {}) {
      const nav = document.querySelector(".nav");
      if (nav && !nav.querySelector("[data-view='exposure']")) {
        const navLabel = options.navLabel || "对外服务";
        const link = document.createElement("a");
        link.href = "#exposure";
        link.dataset.view = "exposure";
        // This entry is injected rather than written in index.html, so it has to
        // carry the same tooltip and accessible name as its static siblings.
        link.title = navLabel;
        link.setAttribute("aria-label", navLabel);
        link.innerHTML = `<i data-lucide="globe-2" aria-hidden="true"></i><span>${escapeHtml(navLabel)}</span>`;
        nav.querySelector("[data-view='download']")?.after(link);
      }
      if ($("#exposure")) {
        bindServiceExposureGuidance();
        return;
      }
      const tools = $("#tools");
      const section = document.createElement("section");
      section.className = "service-exposure-page view-panel";
      section.id = "exposure";
      section.dataset.viewPanel = "exposure";
      section.innerHTML = serviceExposureHtml(options);
      tools?.before(section);
      bindServiceExposureGuidance();
    }

    function bindServiceExposureGuidance() {
      const mode = $("#exposureMode");
      if (!mode || mode.dataset.guidanceBound === "true") return;
      mode.dataset.guidanceBound = "true";
      mode.addEventListener("change", updateServiceExposureOptionStates);
      $("#exposureCorsMode")?.addEventListener("change", updateServiceExposureOptionStates);
      $("#exposureRequireApiKey")?.addEventListener("change", updateServiceExposureOptionStates);
      updateServiceExposureOptionStates();
    }

    function updateServiceExposureOptionStates() {
      const mode = $("#exposureMode")?.value || "local";
      const publicUrl = $("#exposurePublicBaseUrl");
      const requireKey = $("#exposureRequireApiKey")?.checked;
      const corsMode = $("#exposureCorsMode")?.value || "open";
      const allowedOrigins = $("#exposureAllowedOrigins");
      const allowedHeaders = $("#exposureAllowedHeaders");
      if (publicUrl) {
        publicUrl.required = mode === "reverse-proxy";
        publicUrl.pattern = mode === "reverse-proxy" ? "https://.*" : "";
        publicUrl.placeholder = mode === "reverse-proxy" ? "https://llm.example.com（必须 HTTPS）" : "仅公网/反向代理模式需要";
      }
      const label = $("#exposureMode")?.closest("label");
      let guidance = label?.querySelector(".option-state-note");
      if (label && !guidance) {
        guidance = document.createElement("small");
        guidance.className = "option-state-note exposure-mode-guidance";
        label.appendChild(guidance);
      }
      if (guidance) {
        guidance.textContent = mode === "local"
          ? "仅本机客户端，适合本地 OpenWebUI 和开发工具。"
          : mode === "lan"
            ? `局域网设备可访问${requireKey ? "，已要求 API Key。" : "；建议启用 API Key。"}`
            : `公网入口必须由 Caddy/Nginx/Tunnel 提供 HTTPS${requireKey ? "，已要求 API Key。" : "；当前尚未要求 API Key。"}`;
      }
      if (allowedOrigins) allowedOrigins.disabled = corsMode === "open";
      if (allowedHeaders) allowedHeaders.disabled = corsMode === "open";
      const corsLabel = $("#exposureCorsMode")?.closest("label");
      let corsGuidance = corsLabel?.querySelector(".cors-policy-guidance");
      if (corsLabel && !corsGuidance) {
        corsGuidance = document.createElement("small");
        corsGuidance.className = "option-state-note cors-policy-guidance";
        corsLabel.appendChild(corsGuidance);
      }
      if (corsGuidance) {
        corsGuidance.textContent = corsMode === "open"
          ? "临时全开放：允许任意浏览器 Origin，并反射预检请求头；API Key、限流和模型权限仍独立生效。"
          : "限制模式：只允许下方 Origin；请求头使用内置安全列表和额外允许列表。";
      }
    }

    function createLaunchWorkflow(options = {}) {
      const form = $(options.formSelector || "#startForm");
      if (!form) return null;
      if (form.__launchWorkflow) return form.__launchWorkflow;

      const stages = Array.isArray(options.stages) ? options.stages.filter((stage) => stage?.id) : [];
      if (!stages.length) return null;

      const nav = document.createElement("div");
      nav.className = "launch-flow-nav";
      nav.setAttribute("role", "tablist");
      nav.setAttribute("aria-label", options.ariaLabel || "启动流程");

      const stageRoot = document.createElement("div");
      stageRoot.className = "launch-flow-stages";
      const stageElements = [];
      const movedBlocks = new Set();

      stages.forEach((stage, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "launch-flow-tab";
        button.dataset.launchStageTarget = stage.id;
        button.setAttribute("role", "tab");
        button.innerHTML = `<span>${index + 1}</span><strong>${escapeHtml(stage.label || stage.id)}</strong><small>${escapeHtml(stage.description || "")}</small>`;
        nav.appendChild(button);

        const section = document.createElement("section");
        section.className = "launch-stage";
        section.dataset.launchStage = stage.id;
        section.setAttribute("role", "tabpanel");
        section.innerHTML = `
          <div class="launch-stage-head">
            <div><span>步骤 ${index + 1} / ${stages.length}</span><h4>${escapeHtml(stage.label || stage.id)}</h4></div>
            <p>${escapeHtml(stage.help || stage.description || "")}</p>
          </div>
          <div class="launch-stage-grid"></div>
        `;
        const grid = section.querySelector(".launch-stage-grid");
        (stage.selectors || []).forEach((selector) => {
          const block = findFormBlock(form, selector);
          if (!block || movedBlocks.has(block)) return;
          movedBlocks.add(block);
          grid.appendChild(block);
        });

        if (index === stages.length - 1) {
          const review = document.createElement("div");
          review.className = "launch-review";
          review.id = options.reviewId || "launchReview";
          const submit = grid.querySelector("button[type='submit']");
          if (submit) grid.insertBefore(review, submit);
          else grid.appendChild(review);
        }

        const footer = document.createElement("div");
        footer.className = "launch-stage-actions";
        if (index > 0) {
          footer.insertAdjacentHTML("beforeend", `<button class="secondary-button" type="button" data-launch-stage-back><span>上一步</span></button>`);
        }
        if (index < stages.length - 1) {
          footer.insertAdjacentHTML("beforeend", `<button class="primary-button" type="button" data-launch-stage-next><span>下一步</span></button>`);
        }
        section.appendChild(footer);
        stageRoot.appendChild(section);
        stageElements.push(section);
      });

      form.prepend(stageRoot);
      form.prepend(nav);
      (options.requiredSelectors || []).forEach((selector) => {
        const element = $(selector);
        if (element) element.required = true;
      });

      let activeIndex = 0;

      function setStage(value, focus = true) {
        const nextIndex = typeof value === "number"
          ? Math.min(stages.length - 1, Math.max(0, value))
          : Math.max(0, stages.findIndex((stage) => stage.id === value));
        activeIndex = nextIndex;
        stageElements.forEach((section, index) => {
          const active = index === nextIndex;
          section.hidden = !active;
          section.classList.toggle("active", active);
        });
        nav.querySelectorAll("[data-launch-stage-target]").forEach((button, index) => {
          const active = index === nextIndex;
          button.classList.toggle("active", active);
          button.setAttribute("aria-selected", active ? "true" : "false");
          button.tabIndex = active ? 0 : -1;
        });
        refresh();
        if (focus) {
          stageElements[nextIndex]?.querySelector("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
          const stickySidebar = document.querySelector(".sidebar");
          const sidebarStyle = stickySidebar ? window.getComputedStyle(stickySidebar) : null;
          const stickyOffset = sidebarStyle?.position === "sticky"
            ? (stickySidebar.getBoundingClientRect().height || 0) + 12
            : 16;
          const stageNavTop = nav.getBoundingClientRect().top || 0;
          window.scrollTo({ top: Math.max(0, window.scrollY + stageNavTop - stickyOffset), left: 0, behavior: "smooth" });
        }
      }

      function validateStage(index) {
        const controls = Array.from(stageElements[index]?.querySelectorAll("input, select, textarea") || []);
        const invalid = controls.find((control) => !control.disabled && !control.checkValidity());
        if (!invalid) return true;
        invalid.reportValidity();
        invalid.focus();
        return false;
      }

      function renderReview() {
        const review = form.querySelector(`#${options.reviewId || "launchReview"}`);
        if (!review) return;
        const content = typeof options.renderReview === "function" ? options.renderReview() : "";
        review.innerHTML = content || `<div class="empty compact">完成前面的选项后，这里会显示最终启动配置。</div>`;
      }

      function refresh() {
        renderReview();
        nav.querySelectorAll("[data-launch-stage-target]").forEach((button, index) => {
          const stage = stageElements[index];
          const required = Array.from(stage.querySelectorAll("[required]"));
          const complete = required.length === 0 || required.every((control) => control.checkValidity());
          button.classList.toggle("complete", complete && index !== activeIndex);
        });
        if (typeof options.onRefresh === "function") options.onRefresh(activeIndex);
      }

      nav.addEventListener("click", (event) => {
        const button = event.target.closest("[data-launch-stage-target]");
        if (!button) return;
        setStage(button.dataset.launchStageTarget);
      });
      stageRoot.addEventListener("click", (event) => {
        if (event.target.closest("[data-launch-stage-next]")) {
          if (validateStage(activeIndex)) setStage(activeIndex + 1);
          return;
        }
        if (event.target.closest("[data-launch-stage-back]")) setStage(activeIndex - 1);
      });
      form.addEventListener("input", refresh);
      form.addEventListener("change", refresh);
      form.addEventListener("invalid", (event) => {
        const index = stageElements.findIndex((stage) => stage.contains(event.target));
        if (index >= 0 && index !== activeIndex) setStage(index, false);
      }, true);

      const api = {
        setStage,
        refresh,
        get activeStage() {
          return stages[activeIndex]?.id || "";
        },
      };
      form.__launchWorkflow = api;
      setStage(0, false);
      return api;
    }

    function confirmLaunch(options = {}) {
      return openConfirmDialog({
        dialogId: "launchConfirmDialog",
        titleId: "launchConfirmTitle",
        bodyId: "launchConfirmBody",
        submitId: "launchConfirmSubmit",
        eyebrow: "启动确认",
        title: options.title || "确认启动",
        bodyHtml: options.body || "",
        confirmLabel: options.confirmLabel || "确认并启动",
        cancelLabel: "返回检查",
      });
    }

    // 通用危险/重要操作确认：停止服务、卸载模型、删除模型、取消下载等
    function confirmAction(options = {}) {
      return openConfirmDialog({
        dialogId: "actionConfirmDialog",
        titleId: "actionConfirmTitle",
        bodyId: "actionConfirmBody",
        submitId: "actionConfirmSubmit",
        eyebrow: options.danger ? "危险操作" : "操作确认",
        title: options.title || "确认操作",
        bodyHtml: options.body || "",
        confirmLabel: options.confirmLabel || "确认执行",
        cancelLabel: options.cancelLabel || "取消",
        danger: Boolean(options.danger),
      });
    }

    function openConfirmDialog(config) {
      let dialog = $(`#${config.dialogId}`);
      if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.className = "launch-confirm-dialog";
        dialog.id = config.dialogId;
        dialog.setAttribute("aria-labelledby", config.titleId);
        dialog.innerHTML = `
          <form method="dialog">
            <div class="launch-confirm-head"><div><span class="confirm-eyebrow"></span><h3 id="${config.titleId}"></h3></div><button class="icon-button" value="cancel" aria-label="关闭" title="关闭"><span aria-hidden="true">×</span></button></div>
            <div class="launch-confirm-body" id="${config.bodyId}"></div>
            <div class="launch-confirm-actions"><button class="secondary-button" value="cancel"></button><button class="primary-button" value="confirm" id="${config.submitId}"></button></div>
          </form>
        `;
        document.body.appendChild(dialog);
      }
      dialog.classList.toggle("confirm-danger", Boolean(config.danger));
      dialog.querySelector(".confirm-eyebrow").textContent = config.eyebrow || "操作确认";
      $(`#${config.titleId}`).textContent = config.title;
      $(`#${config.bodyId}`).innerHTML = config.bodyHtml || "";
      const cancelButton = dialog.querySelector(".launch-confirm-actions .secondary-button");
      cancelButton.textContent = config.cancelLabel || "取消";
      const submit = $(`#${config.submitId}`);
      submit.textContent = config.confirmLabel || "确认";
      submit.classList.toggle("danger-button", Boolean(config.danger));
      return new Promise((resolve) => {
        const handleClose = () => {
          dialog.removeEventListener("close", handleClose);
          resolve(dialog.returnValue === "confirm");
        };
        dialog.addEventListener("close", handleClose);
        dialog.showModal();
      });
    }

    function findFormBlock(form, selector) {
      const node = typeof selector === "string" ? $(selector) : selector;
      if (!node || !form.contains(node)) return null;
      let block = node;
      while (block.parentElement && block.parentElement !== form) block = block.parentElement;
      return block.parentElement === form ? block : null;
    }

    return {
      ensureServiceExposureUi,
      updateServiceExposureOptionStates,
      createLaunchWorkflow,
      confirmLaunch,
      confirmAction,
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
              <label><span>排队容量</span><input id="exposureMaxQueuedRequests" name="maxQueuedRequests" type="number" min="0" max="4096" value="128" /></label>
              <label><span>最长排队秒数</span><input id="exposureQueueTimeoutSeconds" name="queueTimeoutSeconds" type="number" min="1" max="600" value="30" /></label>
              <label><span>请求超时秒数</span><input id="exposureRequestTimeoutSeconds" name="requestTimeoutSeconds" type="number" min="10" max="7200" value="600" /></label>
              <label>
                <span>CORS 策略</span>
                <select id="exposureCorsMode" name="corsMode">
                  <option value="open">全部开放（临时）</option>
                  <option value="restricted">限制来源与请求头</option>
                </select>
              </label>
              <label class="wide-field"><span>浏览器允许来源（限制模式）</span><textarea id="exposureAllowedOrigins" name="allowedOrigins" rows="3" placeholder="每行一个完整 Origin，例如 capacitor://localhost 或 https://example.com"></textarea></label>
              <label class="wide-field"><span>额外允许请求头（限制模式）</span><textarea id="exposureAllowedHeaders" name="allowedHeaders" rows="2" placeholder="每行一个 Header，例如 user-agent 或 x-client-version；常用鉴权头已内置"></textarea></label>
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
              <input name="maxQueuedRequests" type="number" min="0" max="4096" value="128" title="排队容量；0 表示并发打满后立即返回 429" />
              <input name="queueTimeoutSeconds" type="number" min="1" max="600" value="30" title="最长排队秒数" />
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
