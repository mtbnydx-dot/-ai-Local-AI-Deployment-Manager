(function () {
  function create(deps = {}) {
    const {
      $,
      state,
      escapeHtml,
      escapeAttr,
      fmtTokens,
      metrics = defaultMetrics,
      summaryParts = defaultSummaryParts,
      availability = () => ({ compatible: true, state: "ok", label: "", reason: "" }),
      copy = {},
    } = deps;

    const text = {
      empty: "No launch profiles.",
      builtin: "Built in",
      noDescription: "No description",
      apply: "Apply",
      remove: "Delete",
      noOptions: "No profiles",
      chooseProfile: "Choose a profile...",
      defaultSummary: "Use common parameter presets here; full management is still in Tools.",
      ...copy,
    };

    function profilesFromState() {
      return [...(state.profiles?.builtin || []), ...(state.profiles?.profiles || [])];
    }

    function renderProfiles() {
      const root = $("#profileList");
      if (!root) return;
      const profiles = profilesFromState();
      renderServiceProfileOptions(profiles);
      if (!profiles.length) {
        root.innerHTML = `<div class="empty compact">${escapeHtml(text.empty)}</div>`;
        return;
      }
      root.innerHTML = profiles.map(renderProfileCard).join("");
    }

    function renderProfileCard(profile) {
      const metricItems = metrics(profile).filter(Boolean);
      const fit = availability(profile) || { compatible: true };
      const disabled = fit.compatible === false;
      return `
        <article class="profile-card" data-profile-state="${escapeAttr(fit.state || (disabled ? "fail" : "ok"))}">
          <div>
            <h4>${escapeHtml(profile.name)}${profile.source === "builtin" ? `<span class="pill">${escapeHtml(text.builtin)}</span>` : ""}${fit.label ? `<span class="profile-fit-badge">${escapeHtml(fit.label)}</span>` : ""}</h4>
            <p>${escapeHtml(profile.description || text.noDescription)}</p>
            ${fit.reason ? `<small class="profile-fit-reason">${escapeHtml(fit.reason)}</small>` : ""}
            <div class="running-meta">
              ${metricItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
            </div>
          </div>
          <div class="job-actions">
            <button class="job-action-button primary" type="button" data-profile-action="apply" data-profile-id="${escapeAttr(profile.id)}" ${disabled ? `disabled title="${escapeAttr(fit.reason || "当前硬件不满足该方案")}"` : ""}>${escapeHtml(text.apply)}</button>
            ${profile.source !== "builtin" ? `<button class="job-action-button danger" type="button" data-profile-action="delete" data-profile-id="${escapeAttr(profile.id)}">${escapeHtml(text.remove)}</button>` : ""}
          </div>
        </article>
      `;
    }

    function renderServiceProfileOptions(profiles = profilesFromState()) {
      const select = $("#serviceProfileSelect");
      if (!select) return;
      const current = select.value;
      if (!profiles.length) {
        select.innerHTML = `<option value="">${escapeHtml(text.noOptions)}</option>`;
        renderServiceProfileSummary();
        return;
      }
      select.innerHTML = `<option value="">${escapeHtml(text.chooseProfile)}</option>` + profiles.map((profile) => {
        const fit = availability(profile) || { compatible: true };
        return `
        <option value="${escapeAttr(profile.id)}" ${fit.compatible === false ? "disabled" : ""}>${escapeHtml(profile.name)}${profile.source === "builtin" ? ` · ${escapeHtml(text.builtin)}` : ""}${fit.label ? ` · ${escapeHtml(fit.label)}` : ""}</option>
      `;
      }).join("");
      const currentProfile = profiles.find((profile) => profile.id === current);
      const currentFit = currentProfile ? availability(currentProfile) : null;
      if (currentProfile && currentFit?.compatible !== false) {
        select.value = current;
      } else {
        select.value = "";
      }
      renderServiceProfileSummary();
    }

    function renderServiceProfileSummary() {
      const summary = $("#serviceProfileSummary");
      const select = $("#serviceProfileSelect");
      if (!summary || !select) return;
      const profile = profilesFromState().find((item) => item.id === select.value);
      if (!profile) {
        summary.textContent = text.defaultSummary;
        return;
      }
      const fit = availability(profile) || { compatible: true };
      summary.textContent = [...summaryParts(profile), fit.reason].filter(Boolean).join(" · ");
    }

    function defaultMetrics(profile) {
      const cfg = profile.config || {};
      return [
        cfg.maxModelLen ? `${fmtTokens(cfg.maxModelLen)} context` : "",
        cfg.maxNumSeqs ? `${fmtTokens(cfg.maxNumSeqs)} concurrency` : "",
      ];
    }

    function defaultSummaryParts(profile) {
      return [profile.description || text.noDescription];
    }

    return {
      renderProfiles,
      renderServiceProfileOptions,
      renderServiceProfileSummary,
    };
  }

  window.LocalAiProfileRenderer = { create };
})();
