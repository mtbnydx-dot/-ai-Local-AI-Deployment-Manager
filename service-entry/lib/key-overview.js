"use strict";
// Key lifecycle overview for the entry page: one place to see every service
// client key across both managers, which ones are expired or disabled, which
// have never been used, and which expire soon. Keys themselves never leave the
// manager stores; the entry only sees the redacted client records.

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function classifyClient(client, nowMs) {
  const expiresAt = parseTime(client.expiresAt);
  if (client.enabled === false) return "disabled";
  if (expiresAt !== null && expiresAt <= nowMs) return "expired";
  return "active";
}

function summarizeServiceKeys(managers = [], options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const unusedDays = Number(options.unusedDays) > 0 ? Number(options.unusedDays) : 30;
  const expiringDays = Number(options.expiringDays) > 0 ? Number(options.expiringDays) : 7;
  const items = [];
  const perManager = [];
  for (const manager of Array.isArray(managers) ? managers : []) {
    const ledger = manager?.clients && typeof manager.clients === "object" ? manager.clients : {};
    const clients = Array.isArray(ledger.clients) ? ledger.clients : [];
    const globalKey = Boolean(manager?.exposure?.settings?.hasApiKey ?? manager?.exposure?.actual?.service?.hasApiKey ?? manager?.exposure?.hasApiKey);
    const managerItems = clients.map((client) => {
      const state = classifyClient(client, nowMs);
      const lastUsedMs = parseTime(client.lastUsedAt);
      const createdMs = parseTime(client.createdAt);
      const expiresMs = parseTime(client.expiresAt);
      const ageMs = createdMs !== null ? nowMs - createdMs : null;
      const idleMs = lastUsedMs !== null ? nowMs - lastUsedMs : ageMs;
      return {
        manager: manager.id,
        managerName: manager.name || manager.id,
        id: String(client.id || ""),
        name: String(client.name || client.label || client.id || ""),
        state,
        createdAt: client.createdAt || null,
        lastUsedAt: client.lastUsedAt || null,
        expiresAt: client.expiresAt || null,
        allowedModels: Array.isArray(client.allowedModels) ? client.allowedModels.slice(0, 20) : [],
        rateLimitRpm: Number(client.rateLimitRpm) || null,
        neverUsed: lastUsedMs === null,
        idleDays: idleMs !== null ? Math.floor(idleMs / DAY_MS) : null,
        unused: state === "active" && idleMs !== null && idleMs >= unusedDays * DAY_MS,
        expiringSoon: state === "active" && expiresMs !== null && expiresMs - nowMs <= expiringDays * DAY_MS,
        managePageUrl: manager.servicePageUrl || (manager.baseUrl ? `${manager.baseUrl}/#exposure` : ""),
      };
    });
    items.push(...managerItems);
    perManager.push({
      manager: manager.id,
      managerName: manager.name || manager.id,
      online: Boolean(manager?.process?.portListening),
      globalKey,
      total: managerItems.length,
      active: managerItems.filter((item) => item.state === "active").length,
      expired: managerItems.filter((item) => item.state === "expired").length,
      disabled: managerItems.filter((item) => item.state === "disabled").length,
      unused: managerItems.filter((item) => item.unused).length,
      expiringSoon: managerItems.filter((item) => item.expiringSoon).length,
      managePageUrl: manager.servicePageUrl || "",
    });
  }
  const order = { active: 0, expired: 1, disabled: 2 };
  items.sort((a, b) => (order[a.state] - order[b.state]) || String(a.name).localeCompare(String(b.name)));
  const attention = [];
  for (const item of items) {
    if (item.state === "expired") attention.push({ level: "warn", client: item, reason: "已过期，仍留在密钥库中；请删除或续期。" });
    else if (item.expiringSoon) attention.push({ level: "warn", client: item, reason: `将在 ${expiringDays} 天内过期。` });
    else if (item.unused) attention.push({ level: "info", client: item, reason: item.neverUsed ? "创建后从未使用。" : `已 ${item.idleDays} 天未使用，考虑吊销。` });
  }
  return {
    updatedAt: new Date(nowMs).toISOString(),
    total: items.length,
    active: items.filter((item) => item.state === "active").length,
    expired: items.filter((item) => item.state === "expired").length,
    disabled: items.filter((item) => item.state === "disabled").length,
    unused: items.filter((item) => item.unused).length,
    expiringSoon: items.filter((item) => item.expiringSoon).length,
    globalKeys: perManager.filter((item) => item.globalKey).map((item) => item.manager),
    thresholds: { unusedDays, expiringDays },
    perManager,
    attention: attention.slice(0, 20),
    clients: items.slice(0, 200),
  };
}

// LAN callers see counts only: names and model allow-lists stay local.
function redactKeySummary(summary) {
  if (!summary || typeof summary !== "object") return summary;
  return { ...summary, attention: undefined, clients: undefined, perManager: (summary.perManager || []).map((item) => ({ ...item, managePageUrl: undefined })) };
}

module.exports = {
  classifyClient,
  redactKeySummary,
  summarizeServiceKeys,
};
