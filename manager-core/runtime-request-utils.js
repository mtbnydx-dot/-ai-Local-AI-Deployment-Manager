function normalizeRuntimeLogTail(value, options = {}) {
  return String(Math.min(
    Number(options.maxTail || 2000),
    Math.max(Number(options.minTail || 1), Number(value || options.defaultTail || 200) || Number(options.defaultTail || 200)),
  ));
}

async function readDockerRuntimeLogs(options = {}) {
  const docker = options.docker;
  const containerName = options.containerName;
  if (typeof docker !== "function" || !containerName) {
    throw new Error("readDockerRuntimeLogs requires docker and containerName.");
  }
  const tail = normalizeRuntimeLogTail(options.tail, {
    minTail: options.minTail,
    maxTail: options.maxTail,
    defaultTail: options.defaultTail,
  });
  const out = await docker(["logs", "--tail", tail, containerName], {
    rejectOnError: false,
    maxBuffer: options.maxBuffer,
  });
  return `${out.stdout || ""}${out.stderr || ""}`;
}

async function testOpenAiChatCompletion(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("testOpenAiChatCompletion requires fetch.");
  const model = String(options.model || "").trim();
  if (!model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  const port = Number(options.port || 0);
  const prompt = String(options.prompt || "Reply with exactly: OK");
  const response = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: Number(options.maxTokens || 256),
    }),
    signal: AbortSignal.timeout(Number(options.timeoutMs || 120000)),
  });
  return {
    status: response.status,
    type: "application/json",
    body: await response.text(),
  };
}

function createRuntimeRequestHandlers(options = {}) {
  const cleanRequired = options.cleanRequired || ((value, name = "value") => {
    const text = String(value || "").trim();
    if (!text) {
      const error = new Error(`${name} is required`);
      error.status = 400;
      throw error;
    }
    return text;
  });

  async function startDockerDesktopRequest({ query = {} } = {}) {
    if (!options.dockerRuntime || typeof options.dockerRuntime.startDockerDesktop !== "function") {
      throw new Error("createRuntimeRequestHandlers requires dockerRuntime.startDockerDesktop.");
    }
    return options.dockerRuntime.startDockerDesktop(query, Number(options.dockerStartTimeoutMs || 120000));
  }

  async function readRuntimeLogsRequest({ query = {} } = {}) {
    return readDockerRuntimeLogs({
      docker: options.docker,
      containerName: options.containerName,
      tail: query.tail,
      defaultTail: options.defaultTail || 200,
      maxTail: options.maxTail,
      maxBuffer: options.maxBuffer,
    });
  }

  async function testRuntimeCompletionRequest({ body = {} } = {}) {
    const apiKey = typeof options.getApiKey === "function" ? await options.getApiKey(body) : "";
    const headers = typeof options.authHeaders === "function"
      ? options.authHeaders(apiKey, body)
      : { ...(options.headers || {}) };
    return testOpenAiChatCompletion({
      fetchImpl: options.fetchImpl,
      port: Number(body.port || options.defaultPort),
      model: cleanRequired(body.model, "model"),
      prompt: String(body.prompt || options.prompt || "Reply with exactly: OK"),
      headers,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
    });
  }

  return {
    startDockerDesktopRequest,
    readRuntimeLogsRequest,
    testRuntimeCompletionRequest,
  };
}

module.exports = {
  createRuntimeRequestHandlers,
  normalizeRuntimeLogTail,
  readDockerRuntimeLogs,
  testOpenAiChatCompletion,
};
