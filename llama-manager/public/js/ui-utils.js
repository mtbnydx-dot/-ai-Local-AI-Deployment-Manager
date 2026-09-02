(function () {
  function create({ $, escapeHtml, renderIcons }) {
    function setButtonBusy(button, label = "处理中...") {
      if (!button) return () => {};
      const previousHtml = button.innerHTML;
      const previousDisabled = button.disabled;
      button.disabled = true;
      button.classList.add("is-busy");
      button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
      return () => {
        button.disabled = previousDisabled;
        button.classList.remove("is-busy");
        button.innerHTML = previousHtml;
        renderIcons();
      };
    }

    function notify(title, detail = "", type = "info") {
      const root = $("#toastRoot");
      if (root) {
        const toast = document.createElement("div");
        toast.className = `toast toast-${type}`;
        toast.setAttribute("role", type === "error" ? "alert" : "status");
        toast.innerHTML = `
          <div class="toast-icon" aria-hidden="true">${type === "error" ? "!" : type === "success" ? "✓" : "i"}</div>
          <div>
            <strong>${escapeHtml(title)}</strong>
            ${detail ? `<span>${escapeHtml(detail)}</span>` : ""}
          </div>
          <button type="button" class="toast-close" aria-label="关闭提示">×</button>
        `;
        root.appendChild(toast);
        const close = () => {
          toast.classList.add("toast-exit");
          window.setTimeout(() => toast.remove(), 180);
        };
        toast.querySelector(".toast-close").addEventListener("click", close);
        window.setTimeout(close, type === "error" ? 9000 : 4800);
      }
    }

    function reportActionError(title, error) {
      const message = error?.message || String(error || "");
      notify(title, message, "error");
    }

    return { setButtonBusy, notify, reportActionError };
  }

  window.LlamaUiUtils = { create };
})();
