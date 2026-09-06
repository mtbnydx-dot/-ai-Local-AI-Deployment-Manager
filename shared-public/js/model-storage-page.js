"use strict";
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const bytes = n => { const value = Number(n || 0), unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0; return `${(value / 1024 ** unit).toFixed(unit ? 2 : 0)} ${["B", "KiB", "MiB", "GiB"][unit]}`; };
let state = { roots: [], migrations: [] }, preview = null, refreshing = false;
async function api(url, body) { const r = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data; }
function notice(message, error = false) { $("notice").textContent = message; $("notice").className = error ? "error" : ""; }
function options(select, items, valueKey, label) { const current = select.value; select.replaceChildren(...items.map(item => { const option = document.createElement("option"); option.value = item[valueKey]; option.textContent = label(item); return option; })); if (items.some(x => x[valueKey] === current)) select.value = current; }
async function confirmAction(title, message, exactPath = "") {
  $("confirmTitle").textContent = title; $("confirmText").textContent = message;
  $("confirmPathLabel").hidden = !exactPath; $("confirmPath").value = ""; $("confirmAccept").disabled = Boolean(exactPath);
  $("confirmPath").oninput = () => { $("confirmAccept").disabled = $("confirmPath").value === "" || $("confirmPath").value !== exactPath; };
  $("confirmDialog").showModal();
  return new Promise(resolve => $("confirmDialog").addEventListener("close", () => resolve($("confirmDialog").returnValue === "accept"), { once: true }));
}
async function refresh(includeModels = false) {
  if (refreshing) return; refreshing = true;
  try {
    const [data, jobs] = await Promise.all([api("/api/model-storage"), api("/api/model-storage/migrations")]);
    const modelsChanged = JSON.stringify(state.migrations.map(j => [j.id, j.state])) !== JSON.stringify(jobs.migrations.map(j => [j.id, j.state]));
    state = { ...data, ...jobs };
    $("roots").innerHTML = state.roots.map(r => `<article class="root"><div class="migration-head"><h3>${escapeHtml(r.label)}</h3><span class="badge ${r.online ? "" : "offline"}">${!r.online ? "离线" : r.id === state.defaultRootId ? "默认下载" : r.mode === "model" ? "已导入" : "可用"}</span></div><div class="path">${escapeHtml(r.path)}</div><p>${r.online ? `剩余 ${bytes(r.freeBytes)} / ${bytes(r.totalBytes)}` : "磁盘或目录不可用，文件登记保留"}</p><div class="actions">${r.online && r.mode === "library" && r.id !== state.defaultRootId ? `<button data-action="default" data-id="${r.id}">设为默认下载位置</button>` : ""}${r.id !== "legacy" ? `<button data-action="unregister" data-id="${r.id}">取消登记</button>` : ""}</div></article>`).join("");
    options($("migrationTarget"), state.roots.filter(r => r.online && r.mode === "library"), "id", r => `${r.label} · ${r.path} · 剩余 ${bytes(r.freeBytes)}`);
    $("taskCount").textContent = `${state.migrations.length} 个任务`;
    $("migrations").innerHTML = state.migrations.map(j => {
      const active = ["copying", "verifying", "publishing", "cleaning"].includes(j.state), retry = ["planned", "failed", "interrupted", "cancelled"].includes(j.state);
      return `<article class="migration"><div class="migration-head"><h3>${escapeHtml(j.source.split(/[\\/]/).pop())}</h3><span class="badge">${escapeHtml({ planned:"待执行", completed:"已完成", copying:"迁移中", verifying:"校验中", publishing:"切换中", cleaning:"清理中", cancelled:"已暂停", interrupted:"已中断", failed:"失败", cleanup_failed:"清理中断", rolled_back:"已回滚" }[j.state] || j.state)}</span></div><div class="path">${escapeHtml(j.source)}<br>→ ${escapeHtml(j.target)}</div><progress max="${j.totalBytes || 1}" value="${j.bytesDone || 0}"></progress><p>${bytes(j.bytesDone)} / ${bytes(j.totalBytes)} · ${j.completedFiles || 0} / ${j.fileCount} 个文件</p><p>${escapeHtml(j.error || j.phase || "等待执行")}</p>${j.currentFile ? `<div class="path">${escapeHtml(j.currentFile)}</div>` : ""}<div class="actions">${retry ? `<button data-action="start" data-id="${j.id}">${j.state === "planned" ? "开始迁移" : "继续迁移"}</button>` : ""}${active && j.state !== "cleaning" ? `<button data-action="cancel" data-id="${j.id}">暂停迁移</button>` : ""}${["completed", "cleanup_failed"].includes(j.state) && !j.sourceRemoved ? `<button data-action="rollback" data-id="${j.id}">切回原路径</button><button class="danger" data-action="cleanup" data-id="${j.id}">清理源文件并释放空间</button>` : ""}</div></article>`;
    }).join("") || "<p>暂无迁移任务。预览后可开始第一项迁移。</p>";
    if (includeModels || modelsChanged) { const data = await api("/api/models"); options($("migrationSource"), data.local || [], "path", m => `${m.label} · ${m.path} · ${bytes(m.size)}`); }
  } finally { refreshing = false; }
}
$("refresh").onclick = () => refresh(true).catch(e => notice(e.message, true));
$("registerForm").onsubmit = async event => { event.preventDefault(); const b = event.submitter; b.disabled = true; try { const form = new FormData(event.target); await api("/api/model-storage/roots", { path: form.get("path"), label: form.get("label"), mode: form.get("mode"), create: form.has("create"), makeDefault: form.has("makeDefault") }); notice("目录已登记，两个管理器现在都可以使用。"); event.target.reset(); await refresh(true); } catch (e) { notice(e.message, true); } finally { b.disabled = false; } };
$("migrationForm").onsubmit = async event => { event.preventDefault(); const b = event.submitter; b.disabled = true; try { const form = new FormData(event.target); preview = await api("/api/model-storage/migrations/plan", Object.fromEntries(form)); $("preview").hidden = false; $("preview").innerHTML = `<h3>迁移预览</h3><div class="path">${escapeHtml(preview.source)}<br>→ ${escapeHtml(preview.target)}</div><p>${preview.fileCount} 个文件，${bytes(preview.totalBytes)}；目标剩余 ${bytes(preview.freeBytes)}。</p><p>复制、SHA256 校验通过后切换路径。源文件保留，可回滚。</p><details><summary>查看文件清单${preview.truncated ? "（前 100 个）" : ""}</summary><ul>${preview.files.map(f => `<li>${escapeHtml(f.path)} · ${bytes(f.size)}</li>`).join("")}</ul></details><div class="actions"><button class="primary" data-action="start" data-id="${preview.id}">按此清单开始迁移</button></div>`; await refresh(); } catch (e) { notice(e.message, true); } finally { b.disabled = false; } };
document.addEventListener("click", async event => {
  const b = event.target.closest("[data-action]"); if (!b) return; const { action, id } = b.dataset; b.disabled = true;
  try {
    if (action === "default") await api("/api/model-storage/default", { id });
    else if (action === "unregister") { if (!await confirmAction("取消目录登记", "只移除列表中的登记，磁盘上的文件会保留。")) return; await api("/api/model-storage/unregister", { id }); }
    else {
      const job = state.migrations.find(j => j.id === id) || preview; if (!job) throw new Error("请刷新后重试。");
      let body = {};
      if (action === "start" && !await confirmAction("开始迁移", `${job.source}\n→ ${job.target}\n\n复制并校验后切换；源文件保留。`)) return;
      if (action === "rollback" && !await confirmAction("切回原路径", "源文件重新校验后恢复旧路径，目标副本也会保留。")) return;
      if (action === "cleanup") { if (!await confirmAction("清理源文件", `两侧文件重新校验通过后，删除下面源目录中的已迁移文件。完成后不能直接切回原路径。\n\n${job.source}`, job.source)) return; body = { confirmSource: job.source }; }
      await api(`/api/model-storage/migrations/${id}/${action}`, body);
      if (action === "start") $("preview").hidden = true;
    }
    notice("操作已提交。"); await refresh(true);
  } catch (e) { notice(e.message, true); } finally { b.disabled = false; }
});
refresh(true).catch(e => notice(e.message, true));
setInterval(() => { if (!document.hidden && !$("confirmDialog").open) refresh().catch(e => notice(e.message, true)); }, 2500);
