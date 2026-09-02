const crypto = require("node:crypto");

function clipText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 16)).trim()} ...[\u622a\u65ad]`;
}

function safeOutputName(name, fallbackPrefix = "model") {
  const cleaned = String(name || "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "-")
    .replace(/[\\/]+/g, "__")
    .replace(/\.\.+/g, ".")
    .trim();
  return cleaned || `${fallbackPrefix}-${Date.now()}`;
}

function normalizeAutomationSettings(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  return {
    idleUnloadEnabled: Boolean(item.idleUnloadEnabled),
    idleMinutes: Math.min(1440, Math.max(5, Number(item.idleMinutes || 30))),
    vramGuardEnabled: Boolean(item.vramGuardEnabled),
    vramPercent: Math.min(99, Math.max(70, Number(item.vramPercent || 94))),
    vramAction: new Set(["warn", "unload"]).has(String(item.vramAction || "")) ? String(item.vramAction) : "warn",
    updatedAt: new Date().toISOString(),
  };
}

function createAutomationSettingsStore({ file, readJsonFile, writeJsonFile }) {
  let cache = null;
  async function getAutomationSettings() {
    if (cache) return cache;
    cache = normalizeAutomationSettings(await readJsonFile(file, {}));
    return cache;
  }

  async function saveAutomationSettings(value) {
    cache = normalizeAutomationSettings(value);
    await writeJsonFile(file, cache);
    return cache;
  }

  return {
    getAutomationSettings,
    saveAutomationSettings,
    normalizeAutomationSettings,
  };
}

function createLaunchProfilesStore({
  file,
  readJsonFile,
  writeJsonFile,
  normalizeLaunchProfile,
  defaultLaunchProfiles,
  makeProfileId,
  limit = 40,
}) {
  async function getLaunchProfiles() {
    const saved = await readJsonFile(file, { version: 1, profiles: [] });
    const userProfiles = Array.isArray(saved.profiles) ? saved.profiles.map(normalizeLaunchProfile).filter(Boolean) : [];
    return {
      version: 1,
      updatedAt: saved.updatedAt || null,
      builtin: defaultLaunchProfiles(),
      profiles: userProfiles,
    };
  }

  async function saveLaunchProfile(input = {}) {
    const profile = normalizeLaunchProfile({
      ...input,
      id: input.id || makeProfileId(input.name || input.label || input.config?.name || "profile"),
      source: "user",
      updatedAt: new Date().toISOString(),
    });
    if (!profile) {
      const error = new Error("profile name is required");
      error.status = 400;
      throw error;
    }
    const ledger = await readJsonFile(file, { version: 1, profiles: [] });
    const profiles = (Array.isArray(ledger.profiles) ? ledger.profiles : [])
      .map(normalizeLaunchProfile)
      .filter(Boolean)
      .filter((item) => item.id !== profile.id);
    profiles.unshift(profile);
    await writeJsonFile(file, {
      version: 1,
      updatedAt: new Date().toISOString(),
      profiles: profiles.slice(0, limit),
    });
    return { ok: true, profile };
  }

  async function deleteLaunchProfile(id) {
    const target = String(id || "").trim();
    if (!target) {
      const error = new Error("profile id is required");
      error.status = 400;
      throw error;
    }
    const ledger = await readJsonFile(file, { version: 1, profiles: [] });
    const before = Array.isArray(ledger.profiles) ? ledger.profiles.length : 0;
    const profiles = (Array.isArray(ledger.profiles) ? ledger.profiles : []).filter((item) => item?.id !== target);
    await writeJsonFile(file, { version: 1, updatedAt: new Date().toISOString(), profiles });
    return { ok: true, removed: before - profiles.length, id: target };
  }

  return {
    getLaunchProfiles,
    saveLaunchProfile,
    deleteLaunchProfile,
  };
}

function modelNoteKey(model) {
  const hash = crypto.createHash("sha1").update(String(model)).digest("hex").slice(0, 10);
  return `${safeOutputName(String(model).replace(/[\\/]/g, "-")).slice(0, 48)}-${hash}`;
}

function createModelNotesStore({ file, readJsonFile, writeJsonFile }) {
  async function getModelNotes() {
    const ledger = await readJsonFile(file, { version: 1, notes: {} });
    return {
      version: 1,
      updatedAt: ledger.updatedAt || null,
      notes: ledger.notes && typeof ledger.notes === "object" ? ledger.notes : {},
    };
  }

  async function saveModelNote(input = {}) {
    const model = String(input.model || input.id || "").trim();
    if (!model) {
      const error = new Error("model is required");
      error.status = 400;
      throw error;
    }
    const key = modelNoteKey(model);
    const ledger = await getModelNotes();
    const note = {
      key,
      model,
      favorite: Boolean(input.favorite),
      tags: Array.isArray(input.tags) ? input.tags.map((tag) => clipText(String(tag).trim(), 32)).filter(Boolean).slice(0, 12) : [],
      note: clipText(String(input.note || ""), 500),
      updatedAt: new Date().toISOString(),
    };
    ledger.notes[key] = note;
    await writeJsonFile(file, { version: 1, updatedAt: new Date().toISOString(), notes: ledger.notes });
    return { ok: true, note };
  }

  async function deleteModelNote(key) {
    const ledger = await getModelNotes();
    const id = String(key || "");
    const existed = Boolean(ledger.notes[id]);
    delete ledger.notes[id];
    await writeJsonFile(file, { version: 1, updatedAt: new Date().toISOString(), notes: ledger.notes });
    return { ok: true, removed: existed ? 1 : 0, id };
  }

  return {
    getModelNotes,
    saveModelNote,
    deleteModelNote,
    modelNoteKey,
  };
}

function normalizeRatioSetting(value, fallback, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number > 1) number /= 100;
  return Math.min(max, Math.max(min, number));
}

function normalizeClaudeCompressionSettings(value = {}, options = {}) {
  const item = value && typeof value === "object" ? value : {};
  const env = options.env || process.env;
  const useEnv = options.useEnv !== false;
  const envEnabled = useEnv ? env.AI_CLAUDE_CONTEXT_COMPRESSION : undefined;
  const enabledDefault = envEnabled === undefined
    ? options.enabledDefault !== undefined ? Boolean(options.enabledDefault) : true
    : !["0", "false", "off", "no"].includes(String(envEnabled).toLowerCase());
  const allowedModes = new Set(options.allowedModes || ["cautious", "balanced", "aggressive"]);
  const requestedMode = String(item.mode || "").toLowerCase();
  const mode = options.forceMode || (allowedModes.has(requestedMode) ? requestedMode : options.modeDefault || "cautious");
  const triggerDefault = Number(options.triggerDefault ?? 0.9);
  const recentDefault = Number(options.recentDefault ?? 0.2);
  const summaryDefault = Number(options.summaryDefault ?? 0.2);
  const triggerValue = item.triggerRatio ?? item.triggerPercent ?? (useEnv ? env.AI_CLAUDE_CONTEXT_TRIGGER_PERCENT : undefined);
  const recentValue = item.recentRatio ?? item.recentPercent ?? (useEnv ? env.AI_CLAUDE_CONTEXT_RECENT_PERCENT : undefined);
  const summaryValue = item.summaryRatio ?? item.summaryPercent ?? (useEnv ? env.AI_CLAUDE_CONTEXT_SUMMARY_PERCENT : undefined);
  const minMessagesMin = Number(options.minMessagesMin || 8);
  const minMessagesMax = Number(options.minMessagesMax || Infinity);
  const minMessages = Math.min(minMessagesMax, Math.max(minMessagesMin, Number(item.minMessages || 8)));
  const settings = {
    enabled: item.enabled === undefined ? enabledDefault : Boolean(item.enabled),
    mode,
    triggerRatio: normalizeRatioSetting(triggerValue, triggerDefault, Number(options.triggerMin ?? 0.5), Number(options.triggerMax ?? 0.99)),
    recentRatio: normalizeRatioSetting(recentValue, recentDefault, Number(options.recentMin ?? 0.05), Number(options.recentMax ?? 0.5)),
    summaryRatio: normalizeRatioSetting(summaryValue, summaryDefault, Number(options.summaryMin ?? 0.05), Number(options.summaryMax ?? 0.5)),
    minMessages,
  };
  if (options.includeUpdatedAt) settings.updatedAt = item.updatedAt || null;
  return settings;
}

function createClaudeCompressionSettingsStore({ file, readJsonFile, writeJsonFile, normalizeOptions = {}, cache = false }) {
  let cached = null;

  async function getClaudeCompressionSettings() {
    if (cache && cached) return cached;
    const saved = await readJsonFile(file, {});
    cached = normalizeClaudeCompressionSettings(saved, normalizeOptions);
    return cached;
  }

  async function saveClaudeCompressionSettings(input = {}) {
    const settings = normalizeClaudeCompressionSettings(input, normalizeOptions);
    if (normalizeOptions.includeUpdatedAt) settings.updatedAt = new Date().toISOString();
    await writeJsonFile(file, settings);
    cached = settings;
    return settings;
  }

  return {
    getClaudeCompressionSettings,
    saveClaudeCompressionSettings,
    normalizeClaudeCompressionSettings: (value = {}) => normalizeClaudeCompressionSettings(value, normalizeOptions),
  };
}

module.exports = {
  clipText,
  safeOutputName,
  normalizeAutomationSettings,
  createAutomationSettingsStore,
  createLaunchProfilesStore,
  createModelNotesStore,
  modelNoteKey,
  normalizeRatioSetting,
  normalizeClaudeCompressionSettings,
  createClaudeCompressionSettingsStore,
};
