(function () {
  const GiB = 1024 ** 3;

  function array(value) {
    if (!value) return [];
    return Array.isArray(value) ? value.filter(Boolean) : [value];
  }

  function text(value) {
    return String(value ?? "").trim();
  }

  function basename(value) {
    const normalized = text(value).replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized.split("/").pop() || normalized;
  }

  function firstNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return number;
    }
    return 0;
  }

  function filePath(file) {
    return text(typeof file === "string" ? file : file?.path || file?.launchModel || file?.name);
  }

  function fileBytes(file) {
    return firstNumber(file?.fileBytes, file?.sizeBytes, file?.totalBytes, file?.size);
  }

  function resolveModelFile(model, file) {
    const value = filePath(file);
    if (!value) return "";
    if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) return value;
    const base = text(model?.path || model?.launchModel).replace(/[\\/]+$/, "");
    if (!base) return value;
    const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
    return `${base}${separator}${value}`;
  }

  function isComponentPath(value) {
    const name = basename(value).toLowerCase();
    return /(?:^|[-_.])(mmproj|dflash|draft)(?:[-_.]|$)/.test(name)
      || /(?:^|[-_.])mtp(?:[-_.]|$)/.test(name) && !/(?:model|kquant|dynamic)/.test(name);
  }

  function normalizeCompatibility(value) {
    if (value === true) return { state: "ok", label: "兼容", detail: "当前运行时已报告可直接加载。", explicit: true };
    if (value === false) return { state: "fail", label: "不兼容", detail: "当前运行时明确报告不支持。", explicit: true };
    if (!value) return { state: "unknown", label: "待核验", detail: "后端尚未报告该变体的运行时兼容性。", explicit: false };
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      if (/^(?:ok|pass|supported|compatible|ready|runnable)$/.test(normalized)) {
        return { state: "ok", label: "兼容", detail: value, explicit: true };
      }
      if (/^(?:fail|failed|unsupported|incompatible|blocked|error)$/.test(normalized)) {
        return { state: "fail", label: "不兼容", detail: value, explicit: true };
      }
      return { state: "warn", label: value, detail: value, explicit: true };
    }
    const rawState = text(value.state || value.status || value.level).toLowerCase();
    const supported = value.supported ?? value.compatible ?? value.runnable ?? value.canRun;
    const state = supported === true || /^(?:ok|pass|supported|compatible|ready|runnable)$/.test(rawState)
      ? "ok"
      : supported === false || /^(?:fail|failed|unsupported|incompatible|blocked|error)$/.test(rawState)
        ? "fail"
        : rawState === "warn" || rawState === "warning" || rawState === "partial"
          ? "warn"
          : "unknown";
    const label = text(value.label || value.title)
      || (state === "ok" ? "兼容" : state === "fail" ? "不兼容" : state === "warn" ? "需留意" : "待核验");
    const requirements = array(value.requiredFeatures || value.requires || value.missingFeatures).map(text).filter(Boolean);
    const detail = text(value.detail || value.reason || value.message || value.note)
      || (requirements.length ? `需要 ${requirements.join("、")}` : "后端尚未提供详细说明。");
    return {
      state,
      label,
      detail,
      explicit: supported !== undefined || Boolean(rawState),
      requiredCommit: text(value.requiredCommit || value.minCommit || value.minimumCommit || value.minimumRevision),
      image: text(value.image || value.runtimeImage || value.runtime?.image || value.version),
    };
  }

  function normalizeVariant(raw, model, index) {
    const shards = array(raw?.shards || raw?.files);
    const launchModel = text(raw?.launchModel || raw?.path || raw?.model || filePath(shards[0]) || model?.launchModel || model?.path);
    const bytes = firstNumber(
      raw?.fileBytes,
      raw?.sizeBytes,
      raw?.totalBytes,
      raw?.size,
      shards.reduce((sum, shard) => sum + fileBytes(shard), 0),
    );
    const parameterCount = firstNumber(raw?.parameterCount, raw?.parameters, raw?.parameter_count);
    const paramsB = firstNumber(raw?.paramsB, parameterCount > 1000000 ? parameterCount / 1e9 : parameterCount);
    const compatibility = normalizeCompatibility(raw?.runtimeCompatibility ?? raw?.compatibility ?? model?.runtimeCompatibility);
    const recommendations = raw?.recommendations || raw?.recommended || raw?.defaults || model?.recommendations || model?.recommended || null;
    return {
      raw,
      index,
      launchModel,
      name: text(raw?.label || raw?.name || basename(launchModel) || `GGUF ${index + 1}`),
      fileBytes: bytes,
      parameterCount,
      paramsB,
      architecture: text(raw?.architecture || raw?.arch || model?.architecture),
      layers: firstNumber(raw?.layers, raw?.blockCount, raw?.block_count),
      kvLayers: firstNumber(raw?.kvLayers),
      embeddingLength: firstNumber(raw?.embeddingLength, raw?.embedding_length),
      attentionHeads: firstNumber(raw?.attentionHeads, raw?.attentionHeadCount, raw?.head_count),
      kvHeads: firstNumber(raw?.kvHeads, raw?.attentionHeadCountKv, raw?.head_count_kv),
      headDim: firstNumber(raw?.headDim, raw?.headDimension, raw?.embeddingHeadDim),
      keyLength: firstNumber(raw?.keyLength),
      valueLength: firstNumber(raw?.valueLength),
      contextLength: firstNumber(raw?.contextLength, raw?.maxContextLength, raw?.context_length, model?.contextLength),
      slidingWindow: firstNumber(raw?.slidingWindow, raw?.slidingWindowSize, raw?.sliding_window),
      slidingWindowPattern: text(raw?.slidingWindowPattern),
      slidingLayers: firstNumber(raw?.slidingLayers),
      globalLayers: Number.isFinite(Number(raw?.globalLayers)) ? Number(raw.globalLayers) : 0,
      quant: text(raw?.quant || raw?.quantization || raw?.quantLabel),
      shards,
      shardCount: firstNumber(raw?.shardCount, shards.length),
      complete: raw?.complete !== false,
      compatibility,
      recommendations,
    };
  }

  function variantsFor(model) {
    const inventory = model?.ggufInventory || {};
    let values = array(model?.ggufVariants || inventory.models || inventory.variants);
    if (!values.length) {
      const legacyFiles = array(model?.ggufFiles).filter((file) => !isComponentPath(filePath(file)));
      const hasGgufSignal = legacyFiles.length > 0
        || model?.hasGguf === true
        || /\.gguf(?:$|[:?#])/i.test(text(model?.launchModel || model?.path));
      if (hasGgufSignal) {
        const selectedValue = inventory.selectedModel || model?.selectedModel;
        const selectedPath = filePath(selectedValue);
        const selectedFile = legacyFiles.find((file) => normalizeRef(filePath(file)) === normalizeRef(selectedPath)) || legacyFiles[0] || selectedValue || {};
        const selected = resolveModelFile(model, selectedFile) || selectedPath || text(model?.launchModel || model?.path);
        if (selected) values = [{ ...selectedFile, launchModel: selected, fileBytes: fileBytes(selectedFile) || model?.size }];
      }
    }
    const variants = values.map((value, index) => normalizeVariant(value, model, index)).filter((variant) => variant.launchModel);
    const selectedValue = inventory.selectedModel || model?.selectedModel || model?.launchModel;
    const selectedModel = text(
      typeof selectedValue === "object"
        ? selectedValue?.launchModel || selectedValue?.path || selectedValue?.name
        : selectedValue,
    );
    variants.forEach((variant) => {
      variant.selected = Boolean(selectedModel && normalizeRef(variant.launchModel) === normalizeRef(selectedModel));
    });
    return variants;
  }

  function normalizeComponent(raw, kind) {
    const path = filePath(raw);
    if (!path) return null;
    return {
      kind,
      path,
      name: text(raw?.label || raw?.name || basename(path)),
      fileBytes: fileBytes(raw),
      compatibility: normalizeCompatibility(raw?.runtimeCompatibility ?? raw?.compatibility),
    };
  }

  function componentsFor(model) {
    const inventory = model?.ggufInventory || {};
    const components = [];
    const add = (value, kind) => array(value).forEach((item) => {
      const component = normalizeComponent(item, kind);
      if (component) components.push(component);
    });
    add(inventory.mmproj || inventory.projectors || model?.mmproj, "mmproj");
    add(inventory.drafts || inventory.dflash || model?.drafts || model?.dflash, "dflash");
    array(model?.components || inventory.components).forEach((item) => {
      const type = text(item?.type || item?.kind || item?.role).toLowerCase();
      add(item, type.includes("mm") || type.includes("project") ? "mmproj" : type.includes("draft") || type.includes("dflash") ? "dflash" : "component");
    });
    if (!components.length) {
      array(inventory.files || model?.ggufFiles).forEach((file) => {
        const path = filePath(file);
        const name = basename(path).toLowerCase();
        if (/mmproj/.test(name)) add(file, "mmproj");
        else if (/dflash|(?:^|[-_.])draft(?:[-_.]|$)/.test(name)) add(file, "dflash");
      });
    }
    const seen = new Set();
    return components.filter((item) => {
      const key = `${item.kind}:${normalizeRef(item.path)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeRef(value) {
    return text(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  function selectedVariant(models, value) {
    const target = normalizeRef(value);
    if (!target) return null;
    // Resolve an exact path globally before considering basenames. Otherwise a
    // model in an earlier directory can steal a same-named GGUF that was selected
    // from a later directory.
    for (const model of array(models)) {
      const variants = variantsFor(model);
      const match = variants.find((variant) => normalizeRef(variant.launchModel) === target);
      if (match) return { model, variant: match, components: componentsFor(model) };
    }
    const targetBase = target.split("/").pop();
    for (const model of array(models)) {
      const variants = variantsFor(model);
      const match = variants.find((variant) => normalizeRef(variant.launchModel).split("/").pop() === targetBase);
      if (match) return { model, variant: match, components: componentsFor(model) };
    }
    return null;
  }

  function compatibilityRank(value) {
    return { ok: 0, warn: 1, unknown: 2, fail: 3 }[value?.state] ?? 2;
  }

  function matchesLibraryFilter(model, options = {}) {
    const search = text(options.search).toLowerCase();
    const compatibility = text(options.compatibility);
    const variants = variantsFor(model);
    if (search) {
      const haystack = [
        model?.id,
        model?.label,
        model?.path,
        ...variants.flatMap((variant) => [variant.name, variant.launchModel, variant.architecture, variant.quant]),
        ...componentsFor(model).flatMap((component) => [component.name, component.path, component.kind]),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (compatibility && compatibility !== "all") {
      if (!variants.some((variant) => variant.compatibility.state === compatibility)) return false;
    }
    return true;
  }

  function formatParams(variant) {
    if (!variant.paramsB) return "";
    return `${variant.paramsB >= 10 ? variant.paramsB.toFixed(0) : variant.paramsB.toFixed(1)}B`;
  }

  function renderCompatibility(compatibility, escapeHtml, escapeAttr) {
    const extra = [compatibility.requiredCommit ? `commit ${compatibility.requiredCommit}` : "", compatibility.image].filter(Boolean).join(" · ");
    const detail = [compatibility.detail, extra].filter(Boolean).join(" · ");
    return `<span class="runtime-compat runtime-compat-${compatibility.state}" title="${escapeAttr(detail)}"><i data-lucide="${compatibility.state === "ok" ? "badge-check" : compatibility.state === "fail" ? "circle-x" : compatibility.state === "warn" ? "triangle-alert" : "circle-help"}"></i>${escapeHtml(compatibility.label)}</span>`;
  }

  function renderVariant(variant, options) {
    const { escapeHtml, escapeAttr, fmtBytes, fmtTokens } = options;
    const metrics = [
      variant.fileBytes ? fmtBytes(variant.fileBytes) : "",
      formatParams(variant),
      variant.quant,
      variant.architecture,
      variant.layers ? `${variant.layers} 层` : "",
      variant.kvHeads ? `${variant.kvHeads} KV heads` : "",
      variant.contextLength ? `${fmtTokens(variant.contextLength)} 原生上下文` : "",
      variant.slidingWindow ? `${fmtTokens(variant.slidingWindow)} sliding window` : "",
      variant.shardCount > 1 ? `${variant.shardCount} 分片${variant.complete ? "" : "（不完整）"}` : "",
    ].filter(Boolean);
    const disabled = variant.compatibility.state === "fail";
    return `
      <li class="gguf-variant-row ${variant.selected ? "selected" : ""}">
        <div class="gguf-variant-main">
          <div class="gguf-variant-title">
            <strong>${escapeHtml(variant.name)}</strong>
            ${variant.selected ? '<span class="pill ok">默认选择</span>' : ""}
            ${renderCompatibility(variant.compatibility, escapeHtml, escapeAttr)}
          </div>
          <code>${escapeHtml(variant.launchModel)}</code>
          <div class="gguf-variant-metrics">${metrics.map((metric) => `<span>${escapeHtml(metric)}</span>`).join("")}</div>
          ${variant.compatibility.detail ? `<p>${escapeHtml(variant.compatibility.detail)}</p>` : ""}
        </div>
        <div class="gguf-variant-actions">
          ${variant.recommendations ? `<button type="button" class="ghost-mini-button" data-gguf-recommend="${variant.index}" title="套用该变体报告的推荐参数"><i data-lucide="wand-sparkles"></i><span>推荐配置</span></button>` : ""}
          <button type="button" class="secondary-button compact-button" data-gguf-use="${variant.index}" ${disabled ? "disabled" : ""} title="${escapeAttr(disabled ? variant.compatibility.detail : "填入启动表单")}"><i data-lucide="play"></i><span>选择</span></button>
        </div>
      </li>
    `;
  }

  function renderModel(model, options, modelIndex) {
    const { escapeHtml, escapeAttr, fmtBytes, fmtTokens } = options;
    const variants = variantsFor(model).sort((left, right) => compatibilityRank(left.compatibility) - compatibilityRank(right.compatibility));
    const components = componentsFor(model);
    const runnable = variants.filter((variant) => variant.compatibility.state !== "fail").length;
    const note = options.findNote?.(model);
    const badges = [
      model?.kind === "cached" ? "HF Cache" : "Local",
      variants.length ? `${variants.length} 个主变体` : "未检测到主 GGUF",
      components.length ? `${components.length} 个组件` : "",
      model?.size ? fmtBytes(model.size) : "",
      note?.favorite ? "收藏" : "",
    ].filter(Boolean);
    const defaultVariant = variants.find((variant) => variant.selected) || variants[0];
    return `
      <article class="model-row model-library-card" data-library-model="${modelIndex}">
        <div class="model-library-summary">
          <div class="model-library-title">
            <div>
              <h4>${escapeHtml(model?.label || model?.id || basename(model?.path))}</h4>
              <p>${escapeHtml(model?.path || model?.launchModel || "")}</p>
            </div>
            <div class="pill-row">${badges.map((badge) => `<span class="pill">${escapeHtml(badge)}</span>`).join("")}</div>
          </div>
          ${note?.note ? `<p class="model-note-text"><strong>备注：</strong>${escapeHtml(note.note)}</p>` : ""}
          ${components.length ? `<div class="gguf-components" aria-label="模型附属组件">${components.map((component) => `<span class="gguf-component gguf-component-${escapeAttr(component.kind)}" title="${escapeAttr(component.path)}"><i data-lucide="${component.kind === "mmproj" ? "image" : component.kind === "dflash" ? "zap" : "puzzle"}"></i><strong>${escapeHtml(component.kind === "mmproj" ? "MMProj（可选视觉）" : component.kind === "dflash" ? "DFlash" : "组件")}</strong>${escapeHtml(component.name)}${component.fileBytes ? ` · ${escapeHtml(fmtBytes(component.fileBytes))}` : ""}</span>`).join("")}</div>` : '<div class="gguf-components-empty">未检测到 mmproj 或 DFlash 组件。</div>'}
        </div>
        <div class="model-library-actions">
          ${defaultVariant ? `<button type="button" class="primary-button compact-button" data-gguf-use="${defaultVariant.index}" ${runnable ? "" : "disabled"} title="选择默认主变体"><i data-lucide="play"></i><span>选择默认</span></button>` : ""}
          ${variants.length ? `<button type="button" class="ghost-mini-button" data-gguf-toggle="${modelIndex}" aria-expanded="${variants.length <= 1 ? "true" : "false"}"><i data-lucide="list-tree"></i><span>变体详情</span></button>` : ""}
        </div>
        ${variants.length ? `<div class="gguf-variant-panel ${variants.length <= 1 ? "" : "collapsed"}" data-gguf-panel="${modelIndex}">
          <div class="gguf-variant-panel-head"><strong>主模型变体</strong><span>每个条目都会把具体 <code>launchModel</code> 传给启动表单，mmproj / DFlash 不会误当成主模型。</span></div>
          <ul class="gguf-variant-list">${variants.map((variant) => renderVariant(variant, { escapeHtml, escapeAttr, fmtBytes, fmtTokens })).join("")}</ul>
        </div>` : ""}
      </article>
    `;
  }

  function renderLibrary(options = {}) {
    const root = options.root;
    if (!root) return { visible: 0, total: 0 };
    const local = array(options.models).filter((model) => matchesLibraryFilter(model, options.filters));
    if (!local.length) {
      const total = array(options.models).length;
      root.innerHTML = `<div class="empty model-library-empty"><i data-lucide="${total ? "search-x" : "database"}"></i><strong>${total ? "没有符合筛选条件的 GGUF" : "尚未发现本地 GGUF 模型"}</strong><span>${total ? "换个关键词或兼容性筛选再试。" : "下载完成后刷新，或在启动页直接填写本地 .gguf 文件。"}</span></div>`;
      options.renderIcons?.();
      return { visible: 0, total };
    }
    root.innerHTML = local.map((model, index) => renderModel(model, options, index)).join("");
    root.querySelectorAll("[data-gguf-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const panel = root.querySelector(`[data-gguf-panel='${button.dataset.ggufToggle}']`);
        if (!panel) return;
        const collapsed = panel.classList.toggle("collapsed");
        button.setAttribute("aria-expanded", collapsed ? "false" : "true");
      });
    });
    root.querySelectorAll("[data-library-model]").forEach((card) => {
      const model = local[Number(card.dataset.libraryModel)];
      const variants = variantsFor(model).sort((left, right) => compatibilityRank(left.compatibility) - compatibilityRank(right.compatibility));
      card.querySelectorAll("[data-gguf-use]").forEach((button) => {
        button.addEventListener("click", () => options.onUse?.({ model, variant: variants.find((item) => item.index === Number(button.dataset.ggufUse)) || variants[0], components: componentsFor(model) }));
      });
      card.querySelectorAll("[data-gguf-recommend]").forEach((button) => {
        button.addEventListener("click", () => options.onRecommend?.({ model, variant: variants.find((item) => item.index === Number(button.dataset.ggufRecommend)) || variants[0], components: componentsFor(model) }));
      });
    });
    options.renderIcons?.();
    return { visible: local.length, total: array(options.models).length };
  }

  window.LlamaGgufUi = {
    variantsFor,
    componentsFor,
    selectedVariant,
    matchesLibraryFilter,
    normalizeCompatibility,
    renderLibrary,
  };
})();
