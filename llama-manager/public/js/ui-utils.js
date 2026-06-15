(function () {
  function create({ $, escapeHtml, renderIcons, showTestResult }) {
    function setButtonBusy(button, label = "处理中...") {
      if (!button) return () => {};
      const previousHtml = button.innerHTML;
      const previousDisabled = button.disabled;
      button.disabled = true;
      button.innerHTML = `<span>${escapeHtml(label)}</span>`;
      return () => {
        button.disabled = previousDisabled;
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
          <div class="toast-icon" aria-hidden="true">${type === "error" ? "!" : type === "success" ? "OK" : "i"}</div>
          <div>
            <strong>${escapeHtml(title)}</strong>
            ${detail ? `<span>${escapeHtml(detail)}</span>` : ""}
          </div>
          <button type="button" class="toast-close" aria-label="关闭提示">x</button>
        `;
        root.appendChild(toast);
        const close = () => {
          toast.classList.add("toast-exit");
          window.setTimeout(() => toast.remove(), 180);
        };
        toast.querySelector(".toast-close").addEventListener("click", close);
        window.setTimeout(close, type === "error" ? 9000 : 4800);
      }
      const text = [title, detail].filter(Boolean).join("：");
      console[type === "error" ? "error" : "log"](text);
      if ($("#testResult") && type === "error") showTestResult({ error: text });
    }

    function reportActionError(title, error) {
      const message = error?.message || String(error || "");
      notify(title, message, "error");
    }

    return { setButtonBusy, notify, reportActionError };
  }

  window.LlamaUiUtils = { create };
})();
