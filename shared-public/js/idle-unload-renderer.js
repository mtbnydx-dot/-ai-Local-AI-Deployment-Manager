// Idle unload settings and the list of runtimes currently released. Shared by
// both managers: the policy and the wake flow are identical, only the engine
// label differs.
(function initIdleUnloadRenderer() {
  function create(deps = {}) {
    const api = deps.api;
    const $ = deps.$ || ((selector) => document.querySelector(selector));
    const escapeHtml = deps.escapeHtml || ((value) => String(value ?? ""));
    const escapeAttr = deps.escapeAttr || escapeHtml;
    const notify = deps.notify || (() => {});
    const confirmAction = deps.confirmAction || (async () => true);
    const formatDateTime = deps.formatDateTime || ((value) => new Date(value).toLocaleString());
    const renderIcons = deps.renderIcons || (() => {});
    const onWake = deps.onWake || (() => {});
    if (typeof api !== "function") throw new Error("LocalAiIdleUnload.create requires api.");

    let state = { settings: null, sleeping: [] };
    let busy = false;

    function renderSettings() {
      const settings = state.settings;
      if (!settings) return;
      const enabled = $("#idleUnloadEnabled");
      const minutes = $("#idleUnloadMinutes");
      const minVram = $("#idleUnloadMinVram");
      const exclude = $("#idleUnloadExclude");
      // Never overwrite a field the user is editing.
      if (enabled && document.activeElement !== enabled) enabled.checked = Boolean(settings.enabled);
      if (minutes && document.activeElement !== minutes) minutes.value = settings.idleMinutes;
      if (minVram && document.activeElement !== minVram) minVram.value = settings.minVramMb;
      if (exclude && document.activeElement !== exclude) exclude.value = (settings.excludeModels || []).join(", ");
      const summary = $("#idleUnloadSummary");
      if (summary) {
        summary.textContent = settings.enabled
          ? `已开启：空闲超过 ${settings.idleMinutes} 分钟且没有排队请求的实例会被释放，启动参数会保留以便唤醒。`
          : "未开启。开启后，长时间没有请求的模型会自动释放显存，随时可以一键唤醒回到同样的配置。";
      }
    }

    function renderSleeping() {
      const root = $("#idleUnloadSleeping");
      if (!root) return;
      if (!state.sleeping.length) {
        root.innerHTML = `<div class="empty compact">当前没有被释放的实例。</div>`;
        return;
      }
      root.innerHTML = state.sleeping.map((item) => {
        const vram = item.vramMb > 0 ? `约 ${(item.vramMb / 1024).toFixed(1)} GB 显存已释放` : "显存已释放";
        const failed = item.wakeError
          ? `<span class="idle-unload-error">上次唤醒失败：${escapeHtml(item.wakeError)}</span>`
          : "";
        return `
          <div class="idle-unload-row">
            <div class="idle-unload-main">
              <strong>${escapeHtml(item.model)}</strong>
              <span class="idle-unload-meta">${escapeHtml(formatDateTime(item.sleptAt))} 释放 · ${escapeHtml(vram)}${item.idleMinutes ? ` · 空闲 ${Math.round(item.idleMinutes)} 分钟` : ""}</span>
              ${failed}
            </div>
            <button type="button" class="primary-button" data-idle-wake="${escapeAttr(item.id)}"${item.hasConfig ? "" : " disabled"}>唤醒</button>
            <button type="button" class="job-action-button" data-idle-forget="${escapeAttr(item.id)}" title="忘记这条记录，不再提示唤醒">忘记</button>
          </div>`;
      }).join("");
      renderIcons();
    }

    async function refresh() {
      try {
        const result = await api("/api/idle-unload");
        state = { settings: result.settings, sleeping: Array.isArray(result.sleeping) ? result.sleeping : [] };
        renderSettings();
        renderSleeping();
      } catch (error) {
        notify(`读取闲置释放设置失败：${error.message}`, true);
      }
    }

    async function save() {
      if (busy) return;
      busy = true;
      try {
        const result = await api("/api/idle-unload", {
          method: "POST",
          body: JSON.stringify({
            enabled: Boolean($("#idleUnloadEnabled")?.checked),
            idleMinutes: Number($("#idleUnloadMinutes")?.value || 30),
            minVramMb: Number($("#idleUnloadMinVram")?.value || 0),
            excludeModels: String($("#idleUnloadExclude")?.value || ""),
          }),
        });
        state.settings = result.settings;
        renderSettings();
        notify("闲置释放设置已保存", "", "success");
      } catch (error) {
        notify(`保存失败：${error.message}`, true);
      } finally {
        busy = false;
      }
    }

    function mount() {
      const root = $("#idleUnloadPanel");
      if (!root) return;
      $("#idleUnloadForm")?.addEventListener("submit", (event) => {
        event.preventDefault();
        save();
      });
      root.addEventListener("click", async (event) => {
        const wakeId = event.target?.dataset?.idleWake;
        if (wakeId) {
          const item = state.sleeping.find((entry) => entry.id === wakeId);
          // A cold start takes minutes and competes for VRAM, so it is never
          // kicked off by a stray click.
          if (!await confirmAction({
            title: "唤醒模型",
            body: `将按释放前的启动参数重新启动 ${item?.model || wakeId}。加载需要时间，期间会占用显存。`,
            confirmText: "唤醒",
          })) return;
          try {
            const result = await api(`/api/idle-unload/${encodeURIComponent(wakeId)}/wake`, { method: "POST" });
            notify("唤醒任务已创建", result.model || "", "success");
            onWake(result);
            await refresh();
          } catch (error) {
            notify(`唤醒失败：${error.message}`, true);
            await refresh();
          }
          return;
        }
        const forgetId = event.target?.dataset?.idleForget;
        if (!forgetId) return;
        const item = state.sleeping.find((entry) => entry.id === forgetId);
        if (!await confirmAction({
          title: "忘记休眠记录",
          body: `将删除 ${item?.model || forgetId} 的休眠记录，之后无法一键唤醒（模型文件和启动方案不受影响）。`,
          confirmText: "忘记",
          danger: true,
        })) return;
        try {
          await api(`/api/idle-unload/${encodeURIComponent(forgetId)}`, { method: "DELETE" });
          await refresh();
        } catch (error) {
          notify(`操作失败：${error.message}`, true);
        }
      });
      refresh();
    }

    return { mount, refresh };
  }

  window.LocalAiIdleUnload = { create };
}());
