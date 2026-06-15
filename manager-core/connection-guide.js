const {
  stripHostBrackets,
  isLoopbackHost,
  isWildcardHost,
} = require("./docker-utils");

function formatUrlHost(host) {
  const value = stripHostBrackets(host);
  return value.includes(":") ? `[${value}]` : value;
}

function resolvePublicManagerHost(host, getLanAddress) {
  const value = stripHostBrackets(host);
  if (isWildcardHost(value)) return stripHostBrackets(getLanAddress?.() || "127.0.0.1") || "127.0.0.1";
  return value || "127.0.0.1";
}

function resolveEffectiveLanHost(boundHost, lanHost, getLanAddress) {
  const explicit = stripHostBrackets(lanHost);
  if (explicit) return explicit;
  const bound = stripHostBrackets(boundHost);
  if (isWildcardHost(bound)) return stripHostBrackets(getLanAddress?.() || "") || null;
  if (!isLoopbackHost(bound)) return bound || null;
  return null;
}

function buildCompatibilityEndpoints(options = {}) {
  const servicePort = Number(options.servicePort || 0);
  const managerPort = Number(options.managerPort || 0);
  const boundHost = options.boundHost || "127.0.0.1";
  const displayHost = options.displayHost || formatUrlHost(boundHost);
  const getLanAddress = typeof options.getLanAddress === "function" ? options.getLanAddress : () => "127.0.0.1";
  const managerLocalBase = `http://127.0.0.1:${managerPort}`;
  const managerPublicHost = resolvePublicManagerHost(options.managerHost || "127.0.0.1", getLanAddress);
  const managerPublicBase = `http://${formatUrlHost(managerPublicHost)}:${managerPort}`;
  const openAiLocalBase = `http://127.0.0.1:${servicePort}/v1`;
  const openAiServiceBase = `http://${displayHost}:${servicePort}/v1`;
  const effectiveLanHost = resolveEffectiveLanHost(boundHost, options.lanHost, getLanAddress);
  const openAiLanBase = effectiveLanHost ? `http://${formatUrlHost(effectiveLanHost)}:${servicePort}/v1` : null;
  const claude = {
    baseUrl: `${managerLocalBase}/claude`,
    messagesUrl: `${managerLocalBase}/claude/v1/messages`,
    countTokensUrl: `${managerLocalBase}/claude/v1/messages/count_tokens`,
    modelsUrl: `${managerLocalBase}/claude/v1/models`,
    publicBaseUrl: managerPublicBase === managerLocalBase ? null : `${managerPublicBase}/claude`,
  };
  if (options.claudeModelAlias) claude.modelAlias = options.claudeModelAlias;
  return {
    openai: {
      baseUrl: openAiLocalBase,
      serviceBaseUrl: openAiServiceBase,
      lanBaseUrl: openAiLanBase,
      chatCompletionsUrl: `${openAiLocalBase}/chat/completions`,
      modelsUrl: `${openAiLocalBase}/models`,
    },
    claude,
  };
}

function buildConnectionGuideSnapshot(options = {}) {
  const runtime = options.runtime || null;
  const endpoint = options.endpoint || {};
  const managerLocal = String(options.managerLocal || "").replace(/\/$/, "");
  const managerLan = options.managerLan ? String(options.managerLan).replace(/\/$/, "") : null;
  const aliases = Array.isArray(options.claudeModelAliases) ? options.claudeModelAliases.filter(Boolean) : [];
  const openAiGatewayBase = `${managerLocal}/serve/v1`;
  const model = runtime?.models?.[0]?.id || runtime?.servedModels?.[0]?.id || "";
  const claude = {
    ...(endpoint.compat?.claude || {}),
    ...(options.claude || {}),
  };
  if (!claude.modelAlias && aliases[0]) claude.modelAlias = aliases[0];
  return {
    ok: Boolean(runtime?.container?.running),
    generatedAt: options.generatedAt || new Date().toISOString(),
    manager: { local: managerLocal, lan: managerLan },
    model,
    openai: {
      baseUrl: openAiGatewayBase,
      chatCompletionsUrl: `${openAiGatewayBase}/chat/completions`,
      modelsUrl: `${openAiGatewayBase}/models`,
      directBaseUrl: endpoint.compat?.openai?.baseUrl || endpoint.localUrl || "",
      apiKey: options.apiKeyLabel || "service-exposure-api-key",
      curl: `curl ${openAiGatewayBase}/models`,
    },
    claude,
    openwebui: {
      baseUrl: openAiGatewayBase,
      model: model || "local-current",
      note: options.openwebuiNote || "OpenWebUI 的 OpenAI API Base URL 建议填管理器 /serve/v1；API Key 使用对外服务页保存的密钥。",
    },
    ccswitch: {
      providerBaseUrl: `${managerLocal}/claude`,
      modelAlias: claude.modelAlias || aliases[0] || "",
      healthUrl: `${managerLocal}/api/tools/health`,
      ...(options.ccswitch || {}),
    },
    ...(options.extra || {}),
  };
}

module.exports = {
  buildCompatibilityEndpoints,
  buildConnectionGuideSnapshot,
};
