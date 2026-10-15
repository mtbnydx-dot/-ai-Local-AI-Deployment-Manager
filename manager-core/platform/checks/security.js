"use strict";

// Security checks (06 §7.2). Probes report facts about files and key counts and
// never their contents; the check output carries paths, kinds and counts only.
function title(zh, en) { return { "zh-CN": zh, "en-US": en }; }

function createChecks(ctx) {
  const descriptor = (id, zh, en, run, extra = {}) => ({ id, group: "security", title: title(zh, en), run, ...extra });
  const keysPage = (id) => ctx.fix(id, "keys-page", "manual", "在密钥页面创建或启用 API Key", "Create or enable an API key on the keys page", "/docs/troubleshooting.md#keys", { link: "/c/keys" });
  const manual = (id, zh, en, docs) => ctx.fix(id, `${id.replace(/^sec\./, "")}-docs`, "manual", zh, en, docs);

  // Key required for a non-loopback listener: requireApiKey "off" defeats it.
  async function keyState() {
    const requirement = String(ctx.value("exposure.requireApiKey", "auto"));
    const summary = await ctx.probe("keySummary");
    return { requirement, required: requirement !== "off", active: Number(summary?.active) || 0, total: Number(summary?.total) || 0, available: summary?.available !== false };
  }

  return [
    descriptor("sec.lan-keys", "局域网访问需要 API Key", "LAN access requires API keys", async () => {
      const lan = [["listeners.admin.lan", "admin"], ["listeners.public.lan", "public"]].filter(([key]) => ctx.value(key, false) === true).map(([, name]) => name);
      if (!lan.length) return { status: "skip", detail: "No listener is open to the LAN.", data: { reason: "lan_off" } };
      const state = await keyState();
      const data = { listeners: lan, requireApiKey: state.requirement, activeKeys: state.active };
      if (!state.required) return { status: "fail", detail: "The LAN is open while exposure.requireApiKey is off; anyone on the network can use the models.", data, fix: keysPage("sec.lan-keys") };
      if (state.available && state.active < 1) return { status: "fail", detail: "The LAN is open but there is no active API key.", data, fix: keysPage("sec.lan-keys") };
      return { status: "ok", detail: "The LAN listener requires a key and at least one key is active.", data };
    }),
    descriptor("sec.public", "公网访问配置", "Public exposure", async () => {
      const baseUrl = String(ctx.value("listeners.public.baseUrl", "") || "").trim();
      if (!baseUrl) return { status: "skip", detail: "No public base URL is configured.", data: { reason: "public_off" } };
      const state = await keyState();
      const data = { baseUrl, requireApiKey: state.requirement, activeKeys: state.active };
      const problems = [];
      if (!/^https:\/\//i.test(baseUrl)) problems.push("the public base URL is not https");
      if (!state.required) problems.push("exposure.requireApiKey is off");
      else if (state.available && state.active < 1) problems.push("there is no active API key");
      if (problems.length) return { status: "fail", detail: `Public exposure is unsafe: ${problems.join("; ")}.`, data, fix: keysPage("sec.public") };
      return { status: "ok", detail: "The public base URL is https and keys are required and available.", data };
    }),
    descriptor("sec.secret-store", "密钥库保护", "Secret store protection", async () => {
      const stores = await ctx.probe("secretStores");
      if (!stores.length) return { status: "ok", detail: "No secret namespace file exists yet.", data: { namespaces: [] } };
      const rows = stores.map((store) => ({ namespace: store.namespace, protection: store.protection, entries: store.entries, parse: store.parse, unprotect: store.unprotect, aclWide: store.acl?.wide === true, aclChecked: store.acl?.checked !== false }));
      const unreadable = rows.filter((row) => row.parse !== "ok" || row.unprotect === "error");
      const wide = rows.filter((row) => row.aclWide);
      const aclOnly = rows.filter((row) => row.protection === "acl-only");
      const data = { namespaces: rows };
      if (unreadable.length) return { status: "fail", detail: `Secret store ${unreadable.map((row) => row.namespace).join(", ")} cannot be read; the file is left untouched.`, data, fix: manual("sec.secret-store", "检查密钥库文件（不会被覆盖）", "Review the secret store file (it is never overwritten)", "/docs/troubleshooting.md#secrets") };
      if (wide.length) return { status: "fail", detail: `Secret store ${wide.map((row) => row.namespace).join(", ")} is readable by accounts other than the owner.`, data, fix: ctx.fix("sec.secret-store", "secure-secret-files", "auto", "重新应用仅所有者可访问的权限", "Re-apply the owner-only permissions", "/docs/troubleshooting.md#secrets") };
      if (aclOnly.length) return { status: "warn", detail: `Secret store ${aclOnly.map((row) => row.namespace).join(", ")} uses file permissions only because DPAPI is unavailable.`, data, fix: manual("sec.secret-store", "检查 DPAPI 是否可用", "Check that DPAPI is available", "/docs/troubleshooting.md#secrets") };
      return { status: "ok", detail: "Every secret namespace is protected and owner-only.", data };
    }),
    descriptor("sec.plaintext-secrets", "明文密钥文件", "Plaintext secret files", async () => {
      const files = await ctx.probe("plaintextSecrets");
      if (!files.length) return { status: "ok", detail: "No plaintext secret file was found.", data: { files: [] } };
      const rows = files.map((file) => ({ path: file.path, kind: file.kind, migratable: file.migratable === true }));
      const migratable = rows.some((row) => row.migratable);
      return {
        status: "warn",
        detail: `${rows.length} plaintext secret file(s) exist outside the secret store.`,
        data: { files: rows },
        fix: migratable
          ? ctx.fix("sec.plaintext-secrets", "secrets-migrate", "confirm", "把明文密钥迁移到密钥库", "Migrate plaintext secrets into the secret store", "/docs/troubleshooting.md#secrets")
          : manual("sec.plaintext-secrets", "手动清理明文密钥文件", "Remove the plaintext secret files manually", "/docs/troubleshooting.md#secrets"),
      };
    }),
  ];
}

module.exports = { createChecks };
