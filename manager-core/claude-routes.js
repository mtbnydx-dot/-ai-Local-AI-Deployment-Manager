const DEFAULT_CLAUDE_MODEL_ROUTES = [
  "/claude/models",
  "/claude/v1/models",
  "/v1/claude/models",
];

const DEFAULT_CLAUDE_MESSAGE_ROUTES = [
  "/claude/messages",
  "/claude/v1/messages",
  "/v1/messages",
  "/claude/v1/messages/v1/messages",
];

const DEFAULT_CLAUDE_COUNT_TOKEN_ROUTES = [
  "/claude/messages/count_tokens",
  "/claude/v1/messages/count_tokens",
  "/v1/messages/count_tokens",
];

function registerClaudeRoutes(app, handlers = {}, options = {}) {
  if (!app) throw new Error("registerClaudeRoutes requires an Express app.");
  const {
    models,
    messages,
    countTokens,
  } = handlers;
  if (typeof models !== "function") throw new Error("registerClaudeRoutes requires a models handler.");
  if (typeof messages !== "function") throw new Error("registerClaudeRoutes requires a messages handler.");
  if (typeof countTokens !== "function") throw new Error("registerClaudeRoutes requires a countTokens handler.");

  const modelRoutes = options.modelRoutes || DEFAULT_CLAUDE_MODEL_ROUTES;
  const messageRoutes = options.messageRoutes || DEFAULT_CLAUDE_MESSAGE_ROUTES;
  const countTokenRoutes = options.countTokenRoutes || DEFAULT_CLAUDE_COUNT_TOKEN_ROUTES;

  for (const route of modelRoutes) app.get(route, models);
  for (const route of messageRoutes) app.post(route, messages);
  for (const route of countTokenRoutes) app.post(route, countTokens);

  return {
    modelRoutes: [...modelRoutes],
    messageRoutes: [...messageRoutes],
    countTokenRoutes: [...countTokenRoutes],
  };
}

module.exports = {
  DEFAULT_CLAUDE_MODEL_ROUTES,
  DEFAULT_CLAUDE_MESSAGE_ROUTES,
  DEFAULT_CLAUDE_COUNT_TOKEN_ROUTES,
  registerClaudeRoutes,
};
