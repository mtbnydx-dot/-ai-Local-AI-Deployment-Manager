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
      copy = {},
    } = deps;

    const text = {
      empty: "No launch profiles.",
      builtin: "Built in",
      noDescription: "No description",
      apply: "Apply",
      remove: "Delete",
      noOptions: "No profiles",
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
      return `
        <article class="profile-card">
          <div>
            <h4>${escapeHtml(profile.name)}${profile.source === "builtin" ? `<span class="pill">${escapeHtml(text.builtin)}</span>` : ""}</h4>
            <p>${escapeHtml(profile.description || text.noDescription)}</p>
            <div class="running-meta">
              ${metricItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
            </div>
          </div>
          <div class="job-actions">
            <button class="job-action-button primary" type="button" data-profile-action="apply" data-profile-id="${escapeAttr(profile.id)}">${escapeHtml(text.apply)}</button>
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
      select.innerHTML = profiles.map((profile) => `
        <option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name)}${profile.source === "builtin" ? ` · ${escapeHtml(text.builtin)}` : ""}</option>
      `).join("");
      if (profiles.some((profile) => profile.id === current)) select.value = current;
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
      summary.textContent = summaryParts(profile).filter(Boolean).join(" · ");
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
