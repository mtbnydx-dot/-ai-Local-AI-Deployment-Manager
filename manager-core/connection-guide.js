const {
  stripHostBrackets,
  isLoopbackHost,
  isWildcardHost,
} = require("./docker-utils");
const { buildOpenAiGatewayAliasList } = require("./gateway-utils");

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

function toDockerHostUrl(baseUrl, dockerHost = "host.docker.internal") {
  const text = String(baseUrl || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (isLoopbackHost(url.hostname)) {
      url.hostname = dockerHost;
      return url.toString().replace(/\/$/, "");
    }
    return text.replace(/\/$/, "");
  } catch {
    return "";
  }
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
  const openAiDockerBase = `http://${options.dockerHost || "host.docker.internal"}:${servicePort}/v1`;
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
      dockerBaseUrl: openAiDockerBase,
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
  const openAiGatewayLanBase = managerLan ? `${managerLan}/serve/v1` : null;
  const model = runtime?.models?.[0]?.id || runtime?.servedModels?.[0]?.id || "";
  const configuredGatewayAliases = Array.isArray(options.openAiModelAliases) && options.openAiModelAliases.length
    ? options.openAiModelAliases.filter(Boolean)
    : ["local-current", "current", "auto", "default"];
  const gatewayAliases = buildOpenAiGatewayAliasList({ aliases: configuredGatewayAliases, runtime });
  const recommendedModel = options.recommendedOpenAiModel || gatewayAliases[0] || model || "local-current";
  const apiKeyRequired = options.apiKeyRequired === true;
  const authNote = apiKeyRequired
    ? "需要在 Authorization 里填写 Bearer Token。"
    : "当前未强制 API Key，本机自用可以留空；如开启 API Key 后再填写 Bearer Token。";
  const reasoningNote = options.reasoningNote
    || "当前模型若启用了 reasoning parser，小 max_tokens 可能先返回 reasoning，正文 content 为空；通用 OpenAI 客户端建议提高 max_tokens，或在启动配置里关闭 reasoning parser。";
  const directBaseUrl = endpoint.compat?.openai?.baseUrl || endpoint.localUrl || "";
  const dockerBaseUrl = endpoint.compat?.openai?.dockerBaseUrl || toDockerHostUrl(directBaseUrl, options.dockerHost);
  const claude = {
    ...(endpoint.compat?.claude || {}),
    ...(options.claude || {}),
  };
  const claudeLanBase = claude.publicBaseUrl || (managerLan ? `${managerLan}/claude` : null);
  if (!claude.modelAlias && aliases[0]) claude.modelAlias = aliases[0];
  return {
    ok: Boolean(runtime?.container?.running),
    generatedAt: options.generatedAt || new Date().toISOString(),
    manager: { local: managerLocal, lan: managerLan },
    model,
    openai: {
      baseUrl: openAiGatewayBase,
      lanBaseUrl: openAiGatewayLanBase,
      chatCompletionsUrl: `${openAiGatewayBase}/chat/completions`,
      modelsUrl: `${openAiGatewayBase}/models`,
      lanModelsUrl: openAiGatewayLanBase ? `${openAiGatewayLanBase}/models` : null,
      directBaseUrl,
      dockerBaseUrl,
      apiKey: options.apiKeyLabel || (apiKeyRequired ? "Bearer <service API key>" : ""),
      apiKeyRequired,
      authNote,
      recommendedModel,
      modelAliases: gatewayAliases,
      reasoningNote,
      curl: `curl ${openAiGatewayLanBase || openAiGatewayBase}/models`,
    },
    claude,
    openwebui: {
      baseUrl: dockerBaseUrl || openAiGatewayLanBase || openAiGatewayBase,
      gatewayBaseUrl: openAiGatewayLanBase || openAiGatewayBase,
      model: recommendedModel,
      actualModel: model || "",
      note: options.openwebuiNote || `Docker 版 OpenWebUI 的 OpenAI API Base URL 建议填 host.docker.internal 直连地址；如果使用管理器 /serve/v1，则需确保容器网络和 Bearer Token 放行。${authNote}`,
    },
    ccswitch: {
      providerBaseUrl: claudeLanBase || `${managerLocal}/claude`,
      modelAlias: claude.modelAlias || aliases[0] || "",
      healthUrl: `${managerLan || managerLocal}/api/tools/health`,
      ...(options.ccswitch || {}),
    },
    ...(options.extra || {}),
  };
}

module.exports = {
  buildCompatibilityEndpoints,
  buildConnectionGuideSnapshot,
  toDockerHostUrl,
};
