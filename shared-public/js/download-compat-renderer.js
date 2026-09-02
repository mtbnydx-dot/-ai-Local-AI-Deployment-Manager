(function () {
  // Download-time compatibility UI shared by both managers: the pre-download
  // check card, the GGUF quant variant picker, the same-model precision
  // repository chips and the resume health summary. Pure rendering; the pages
  // fetch the data and wire the events.
  const defaultEscape = (value) => (window.LocalAiDomUtils ? window.LocalAiDomUtils.escapeHtml(value) : String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch])));
  const defaultBytes = (value) => {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    let current = number;
    while (current >= 1024 && index < units.length - 1) {
      current /= 1024;
      index += 1;
    }
    return `${current.toFixed(current >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
  };

  function helper(options, name, fallback) {
    return typeof options?.[name] === "function" ? options[name] : fallback;
  }

  const LEVEL_LABELS = {
    ok: { title: "下载前预检：可以下载", icon: "badge-check" },
    info: { title: "下载前预检：可以下载，有提示", icon: "info" },
    warn: { title: "下载前预检：可以下载，但要注意", icon: "alert-triangle" },
    block: { title: "下载前预检：已阻断", icon: "octagon-x" },
    loading: { title: "正在做下载前兼容预检...", icon: "loader" },
    error: { title: "预检未完成", icon: "alert-circle" },
  };
  const SEVERITY_LABELS = { ok: "通过", info: "提示", warn: "注意", block: "阻断" };
  const SEVERITY_RANK = { block: 0, warn: 1, info: 2, ok: 3 };

  function renderPrecheck(root, result, options = {}) {
    if (!root) return;
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    if (!result) {
      root.hidden = true;
      root.innerHTML = "";
      return;
    }
    root.hidden = false;
    if (result.error) {
      root.dataset.state = "error";
      root.innerHTML = `<div class="precheck-head"><i data-lucide="${LEVEL_LABELS.error.icon}"></i><strong>${LEVEL_LABELS.error.title}</strong><span>${escapeHtml(result.error)}</span></div>`;
      return;
    }
    const level = LEVEL_LABELS[result.level] ? result.level : "info";
    root.dataset.state = level;
    const findings = Array.isArray(result.findings) ? [...result.findings] : [];
    findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
    const primary = findings.filter((item) => item.severity === "block" || item.severity === "warn");
    const secondary = findings.filter((item) => item.severity !== "block" && item.severity !== "warn");
    const capability = result.capability || {};
    const identity = capability.label
      ? `${escapeHtml(capability.label)}${capability.heuristic ? "（按名称推断）" : ""}`
      : "未识别架构";
    const engineLabel = result.engine === "llama" ? "llama.cpp" : "vLLM";
    const item = (finding) => `
      <li class="precheck-item" data-severity="${escapeHtml(finding.severity)}">
        <span class="precheck-badge">${SEVERITY_LABELS[finding.severity] || finding.severity}</span>
        <span class="precheck-copy"><strong>${escapeHtml(finding.title)}</strong>${finding.detail ? `<small>${escapeHtml(finding.detail)}</small>` : ""}</span>
      </li>`;
    root.innerHTML = `
      <div class="precheck-head">
        <i data-lucide="${LEVEL_LABELS[level].icon}"></i>
        <strong>${LEVEL_LABELS[level].title}</strong>
        <span>${identity} · ${engineLabel}${result.quantMethod ? ` · ${escapeHtml(result.quantMethod)}` : ""}${result.remoteConfig?.ok ? " · 已读取远端 config.json" : ""}</span>
      </div>
      ${primary.length ? `<ul class="precheck-findings">${primary.map(item).join("")}</ul>` : ""}
      ${secondary.length ? `<details class="precheck-more"${primary.length ? "" : " open"}><summary>其余 ${secondary.length} 项检查</summary><ul class="precheck-findings">${secondary.map(item).join("")}</ul></details>` : ""}
      ${level === "block" ? `<p class="precheck-blocked">这个仓库在当前运行时不能启动，下载按钮已停用；请按上面的提示换仓库或换引擎。</p>` : ""}
    `;
  }

  const FIT_LABELS = { fits: "可整模型进显存", tight: "显存偏紧", exceeds: "超出显存", unknown: "显存未知" };

  function renderGgufVariants(root, listing, options = {}) {
    if (!root) return;
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const escapeAttr = helper(options, "escapeAttr", defaultEscape);
    const fmtBytes = helper(options, "fmtBytes", defaultBytes);
    const variants = Array.isArray(listing?.variants) ? listing.variants : [];
    if (!listing || !listing.supported || !variants.length) {
      root.hidden = true;
      root.innerHTML = "";
      return;
    }
    const engine = options.engine === "llama" ? "llama" : "vllm";
    const selected = String(options.selectedQuant || listing.selected || "").toUpperCase();
    const rows = variants.map((variant) => {
      const fit = variant.fit || { status: "unknown", note: "" };
      const disabled = engine === "vllm" && !variant.vllmLoadable;
      const checked = selected && variant.quant.toUpperCase() === selected;
      return `
        <label class="variant-row${disabled ? " is-disabled" : ""}${checked ? " is-selected" : ""}" title="${escapeAttr(fit.note || "")}">
          <input type="radio" name="ggufVariant" value="${escapeAttr(variant.quant)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""} />
          <span class="variant-quant">${escapeHtml(variant.quant)}</span>
          <span class="variant-size">${escapeHtml(fmtBytes(variant.bytes))}${variant.multiPart ? ` · ${variant.fileCount} 分片${variant.complete ? "" : "（不完整）"}` : ""}</span>
          <span class="fit-badge" data-fit="${escapeAttr(fit.status)}">${FIT_LABELS[fit.status] || fit.status}</span>
          ${disabled ? `<small class="variant-note">多分片，vLLM 不能加载；请用 llama.cpp</small>` : ""}
        </label>`;
    });
    const companion = (file, kind, label) => `
      <label class="variant-extra">
        <input type="checkbox" name="ggufExtra" value="${escapeAttr(kind === "mmproj" ? "*mmproj*.gguf" : "*dflash*.gguf,*draft*.gguf,*eagle*.gguf")}" />
        <span>${label}：${escapeHtml(file.name)}（${escapeHtml(fmtBytes(file.size))}）</span>
      </label>`;
    const extras = [
      ...(listing.mmproj || []).slice(0, 1).map((file) => companion(file, "mmproj", "同时下载视觉投影 mmproj")),
      ...(listing.drafts || []).slice(0, 1).map((file) => companion(file, "draft", "同时下载 DFlash/draft 草稿模型")),
    ];
    root.hidden = false;
    root.innerHTML = `
      <div class="variant-head">
        <strong>GGUF 量化变体</strong>
        <span>仓库内 ${variants.length} 个量化，按体积与本机显存标注可行性；选中后会作为下载精度过滤。</span>
      </div>
      <div class="variant-list">${rows.join("")}</div>
      ${extras.length ? `<div class="variant-extras">${extras.join("")}</div>` : ""}
    `;
  }

  const SUPPORT_LABELS = { ok: "可直接跑", warn: "有限支持", block: "不能跑" };

  function renderPrecisionVariants(root, grouped, options = {}) {
    if (!root) return;
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const escapeAttr = helper(options, "escapeAttr", defaultEscape);
    const variants = Array.isArray(grouped?.variants) ? grouped.variants.filter((item) => !item.isCurrent) : [];
    if (!variants.length) {
      root.hidden = true;
      root.innerHTML = "";
      return;
    }
    const engine = options.engine === "llama" ? "llama" : "vllm";
    const chips = variants.slice(0, 8).map((variant) => {
      const support = variant.support?.[engine] || "block";
      const note = (variant.support?.notes || []).join(" ");
      return `<button type="button" class="variant-chip" data-support="${escapeAttr(support)}" data-variant-repo="${escapeAttr(variant.id)}" title="${escapeAttr(note || variant.id)}">
        <strong>${escapeHtml(variant.precision)}</strong>
        <span>${escapeHtml(variant.id)}</span>
        <em>${SUPPORT_LABELS[support] || support}${variant.gated ? " · gated" : ""}</em>
      </button>`;
    });
    root.hidden = false;
    root.innerHTML = `
      <div class="variant-head">
        <strong>同模型的其他精度仓库</strong>
        <span>按当前引擎标注能否直接运行；点击即可切换到该仓库。</span>
      </div>
      <div class="variant-chips">${chips.join("")}</div>
    `;
  }

  function renderResumeCheck(check, options = {}) {
    const escapeHtml = helper(options, "escapeHtml", defaultEscape);
    const fmtBytes = helper(options, "fmtBytes", defaultBytes);
    const rows = [];
    if (!check.exists) {
      rows.push("<p>本地目录已不存在，继续下载会从头开始。</p>");
    } else {
      rows.push(`<p>本地已有 <strong>${escapeHtml(fmtBytes(check.onDiskBytes))}</strong>${check.manifestFiles ? `；清单 ${check.manifestFiles} 个文件：<strong>${check.complete.length}</strong> 个完整、<strong>${check.partial.length}</strong> 个部分、<strong>${check.missing.length}</strong> 个缺失` : ""}。</p>`);
    }
    if (check.remainingBytes !== null && check.remainingBytes !== undefined) {
      rows.push(`<p>预计还需下载 <strong>${escapeHtml(fmtBytes(check.remainingBytes))}</strong>${check.diskFreeBytes ? `，模型盘剩余 ${escapeHtml(fmtBytes(check.diskFreeBytes))}${check.diskOk === false ? "，<strong>空间不足</strong>" : ""}` : ""}。</p>`);
    }
    if (check.incompleteFiles) rows.push(`<p>有 ${check.incompleteFiles} 个 .incomplete 分片会被复用。</p>`);
    const preview = [...check.partial.map((item) => `${item.name}（已有 ${fmtBytes(item.actual || 0)} / ${fmtBytes(item.expected || 0)}）`), ...check.missing.map((item) => `${item.name}（缺失，${fmtBytes(item.size || 0)}）`)].slice(0, 6);
    if (preview.length) rows.push(`<p class="subtle" style="font-size:12px">${preview.map(escapeHtml).join("<br>")}${check.partial.length + check.missing.length > 6 ? `<br>… 共 ${check.partial.length + check.missing.length} 个` : ""}</p>`);
    return rows.join("");
  }

  function formatProbeSummary(result, fmtBytes = defaultBytes) {
    const fmtProbe = (item) => (item?.ok ? `${Math.round(item.ms)}ms / ${fmtBytes(item.bytesPerSec)}/s` : `失败（${item?.error || "无响应"}）`);
    return `官方 ${fmtProbe(result.official)} · 镜像 ${fmtProbe(result.mirror)} · ModelScope ${fmtProbe(result.modelscope)}${result.modelScopeRepo ? `（${result.modelScopeRepo}）` : ""}`;
  }

  window.downloadCompatRenderer = {
    renderPrecheck,
    renderGgufVariants,
    renderPrecisionVariants,
    renderResumeCheck,
    formatProbeSummary,
  };
})();
