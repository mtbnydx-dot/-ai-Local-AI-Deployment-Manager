(() => {
  const select = document.querySelector("#downloadStorage");
  if (!select) return;
  fetch("/api/model-storage").then(r => r.ok ? r.json() : null).then(data => {
    if (!data) return;
    select.replaceChildren(...data.roots.filter(r => r.mode === "library").map(r => {
      const option = document.createElement("option"); option.value = r.id;
      option.textContent = `${r.label} · ${r.path}${r.online ? ` · 剩余 ${(r.freeBytes / 1024 ** 3).toFixed(1)} GiB` : " · 离线"}`;
      option.disabled = !r.online; option.selected = r.id === data.defaultRootId; return option;
    }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }).catch(() => {});
})();
