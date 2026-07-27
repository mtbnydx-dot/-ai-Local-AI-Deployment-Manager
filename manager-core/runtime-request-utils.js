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

async function probeOpenAiGeneration(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("probeOpenAiGeneration requires fetch.");
  const model = String(options.model || options.servedModels?.[0]?.id || "").trim();
  if (!model) return { ok: false, detail: "模型列表为空，无法执行生成自检。" };
  const port = Number(options.port || 0);
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || 180000));
  const headers = {
    "content-type": "application/json",
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...(options.headers || {}),
  };
  const prompt = String(options.prompt || "Reply with exactly OK.");
  const attempts = [
    {
      kind: "chat",
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      body: {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: Number(options.maxTokens || 32),
        chat_template_kwargs: {
          enable_thinking: false,
          ...(options.chatTemplateKwargs || {}),
        },
      },
    },
    {
      kind: "completion",
      url: `http://127.0.0.1:${port}/v1/completions`,
      body: {
        model,
        prompt,
        temperature: 0,
        max_tokens: Number(options.maxTokens || 32),
      },
    },
  ];
  let lastDetail = "";
  for (const attempt of attempts) {
    let response;
    let bodyText = "";
    try {
      response = await fetchImpl(attempt.url, {
        method: "POST",
        headers,
        body: JSON.stringify(attempt.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      bodyText = await response.text();
    } catch (error) {
      lastDetail = `${attempt.kind} 请求失败：${error.message}`;
      continue;
    }
    if (!response.ok) {
      lastDetail = `${attempt.kind} 返回 HTTP ${response.status}: ${clipProbeText(bodyText)}`;
      if (![400, 404, 405, 422].includes(response.status)) break;
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (error) {
      return { ok: false, detail: `${attempt.kind} 返回了非 JSON 内容：${error.message}` };
    }
    const choice = payload?.choices?.[0] || {};
    const generated = attempt.kind === "chat"
      // Recent vLLM nightlies renamed the response field from the deprecated
      // reasoning_content to reasoning. Keep both because pinned images in the
      // manager can legitimately use either protocol revision.
      ? choice.message?.content || choice.message?.reasoning || choice.message?.reasoning_content || choice.text || ""
      : choice.text || "";
    const validation = validateGeneratedProbeText(generated);
    if (!validation.ok) return { ...validation, model, endpoint: attempt.kind };
    return {
      ok: true,
      model,
      endpoint: attempt.kind,
      detail: `${attempt.kind} 生成自检通过：${clipProbeText(generated)}`,
      preview: clipProbeText(generated),
    };
  }
  return { ok: false, model, detail: lastDetail || "生成自检没有得到有效响应。" };
}

function validateGeneratedProbeText(value) {
  const text = String(value || "").trim();
  if (!text) return { ok: false, detail: "生成接口返回成功，但输出内容为空。" };
  if (text.includes("\uFFFD") || /锟斤拷|Ã.|Â.|â€/.test(text)) {
    return { ok: false, detail: `生成结果包含疑似编码损坏字符：${clipProbeText(text)}` };
  }
  if (/([!！?？#@$%^&*_=+\-.])\1{7,}/u.test(text)) {
    return { ok: false, detail: `生成结果出现重复符号退化：${clipProbeText(text)}` };
  }
  const compact = text.replace(/\s/g, "");
  if (compact.length >= 12 && new Set(compact).size <= 2) {
    return { ok: false, detail: `生成结果疑似低熵循环：${clipProbeText(text)}` };
  }
  return { ok: true, detail: "生成输出有效。" };
}

function clipProbeText(value, limit = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
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
  probeOpenAiGeneration,
  readDockerRuntimeLogs,
  testOpenAiChatCompletion,
  validateGeneratedProbeText,
};
