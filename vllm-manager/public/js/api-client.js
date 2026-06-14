(function () {
  async function request(path, options = {}) {
    const response = await fetch(path, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
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

  window.VllmApi = {
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
