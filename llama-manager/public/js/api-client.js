(function () {
  const DEFAULT_TIMEOUT_MS = 20000;

  async function request(path, options = {}) {
    const hasBody = options.body !== undefined && options.body !== null;
    const headers = {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    };
    // 默认 20s 超时，调用方可用 options.signal 自行控制
    const signal = options.signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(path, { ...options, headers, signal });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        const timeoutError = new Error(`请求超时（${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s）：${path}`);
        timeoutError.code = "request_timeout";
        throw timeoutError;
      }
      throw error;
    }
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Plain text or Markdown response.
    }
    if (!response.ok) {
      const error = new Error(body && body.error ? body.error : text || response.statusText);
      error.status = response.status;
      error.code = body && body.code ? body.code : null;
      throw error;
    }
    return body;
  }

  window.LlamaApi = {
    create(getAuditToken) {
      return {
        api: request,
        auditApi(path, options = {}) {
          return request(path, {
            ...options,
            headers: {
              authorization: `Bearer ${getAuditToken() || ""}`,
              ...(options.headers || {}),
            },
          });
        },
      };
    },
  };
})();
