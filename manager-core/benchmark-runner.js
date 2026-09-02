const { parseJsonSafe } = require("./common-utils");

function createBenchmarkRunner(options = {}) {
  const defaultPort = Number(options.defaultPort || 8000);
  const defaultPrompt = String(options.defaultPrompt || "Summarize local model readiness briefly.");
  const runtimeLabel = options.runtimeLabel || "model service";
  const requestDetail = options.requestDetail || `Sending chat completion request to local ${runtimeLabel}.`;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof options.getRunningModelSummary !== "function") throw new Error("createBenchmarkRunner requires getRunningModelSummary.");
  if (typeof fetchImpl !== "function") throw new Error("createBenchmarkRunner requires fetch.");

  function normalizeBenchmarkRequest(input = {}) {
    const requests = boundedInteger(input.requests, 3, 1, 64);
    return {
      port: Number(input.port || defaultPort),
      model: String(input.model || "").trim(),
      requests,
      concurrency: Math.min(requests, boundedInteger(input.concurrency, 1, 1, 16)),
      warmupRequests: boundedInteger(input.warmupRequests, 0, 0, 4),
      maxTokens: boundedInteger(input.maxTokens, 160, 16, 8192),
      stream: input.stream === true,
      prompt: String(input.prompt || defaultPrompt),
    };
  }

  async function runBenchmarkJob(job, input = {}) {
    const config = normalizeBenchmarkRequest(input);
    const runtime = await options.getRunningModelSummary();
    const model = config.model || runtime.models?.[0]?.id;
    if (!runtime.container?.running || !model) throw new Error(`No running ${runtimeLabel} model is available for benchmark.`);
    const port = Number(config.port || runtime.endpoint?.port || defaultPort);
    const headers = {
      "content-type": "application/json",
      ...(typeof options.getHeaders === "function" ? options.getHeaders(runtime) : {}),
    };
    for (let index = 0; index < config.warmupRequests; index += 1) {
      options.setJobProgress?.(job, {
        percent: Math.round(((index + 1) / Math.max(1, config.warmupRequests)) * 8),
        stage: `Warmup ${index + 1}/${config.warmupRequests}`,
        detail: requestDetail,
      });
      await executeCompletion({ config, headers, model, port, index: -(index + 1) });
    }

    const samples = new Array(config.requests);
    let cursor = 0;
    let completed = 0;
    const wallStarted = Date.now();
    async function worker() {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= config.requests) return;
        try {
          samples[index] = await executeCompletion({ config, headers, model, port, index });
          options.appendLog?.(job, `Run ${index + 1}: ${samples[index].elapsedMs} ms, TTFT ${samples[index].ttftMs} ms, ${samples[index].outputTokens} output tokens.`);
        } catch (error) {
          samples[index] = { index, error: error.message, elapsedMs: 0, ttftMs: 0, promptTokens: 0, outputTokens: 0, tokensPerSecond: 0, endToEndTokensPerSecond: 0, preview: "" };
          options.appendLog?.(job, `Run ${index + 1} failed: ${error.message}`);
        }
        completed += 1;
        options.setJobProgress?.(job, {
          percent: 10 + Math.round((completed / config.requests) * 80),
          stage: `Benchmark ${completed}/${config.requests} · C${config.concurrency}`,
          detail: requestDetail,
        });
      }
    }
    await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
    const wallElapsedMs = Date.now() - wallStarted;
    const successful = samples.filter((item) => item && !item.error);
    if (!successful.length) throw new Error(`All ${config.requests} benchmark requests failed: ${samples[0]?.error || "unknown error"}`);
    const avgMs = average(successful.map((item) => item.elapsedMs));
    const avgTps = average(successful.map((item) => item.tokensPerSecond));
    const avgTtftMs = average(successful.map((item) => item.ttftMs).filter((value) => value > 0));
    const totalOutputTokens = successful.reduce((sum, item) => sum + item.outputTokens, 0);
    const wallTokensPerSecond = wallElapsedMs > 0 ? totalOutputTokens / (wallElapsedMs / 1000) : 0;
    const latencyMs = successful.map((item) => item.elapsedMs);
    const ttftMs = successful.map((item) => item.ttftMs).filter((value) => value > 0);
    const failedRequests = samples.length - successful.length;
    const benchmark = {
      model,
      port,
      requests: config.requests,
      successfulRequests: successful.length,
      failedRequests,
      concurrency: config.concurrency,
      warmupRequests: config.warmupRequests,
      stream: config.stream,
      maxTokens: config.maxTokens,
      wallElapsedMs,
      totalOutputTokens,
      avgMs,
      p50Ms: percentile(latencyMs, 0.5),
      p95Ms: percentile(latencyMs, 0.95),
      avgTtftMs,
      p50TtftMs: percentile(ttftMs, 0.5),
      p95TtftMs: percentile(ttftMs, 0.95),
      avgTokensPerSecond: avgTps,
      wallTokensPerSecond,
      samples,
    };
    options.setJobProgress?.(job, { percent: 100, stage: "Benchmark complete", detail: `${wallTokensPerSecond.toFixed(2)} tok/s wall throughput · ${avgTtftMs.toFixed(0)} ms TTFT`, state: failedRequests ? "warn" : "ok" });
    options.finishJob?.(job, {
      benchmark,
    });
    return benchmark;
  }

  async function executeCompletion({ config, headers, model, port, index }) {
    const started = Date.now();
    const response = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: config.prompt }],
        temperature: 0,
        max_tokens: config.maxTokens,
        stream: config.stream,
        ...(config.stream ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: AbortSignal.timeout(Number(options.timeoutMs || 180000)),
    });
    if (!config.stream) {
      const text = await response.text();
      const data = parseJsonSafe(text, {});
      if (!response.ok) throw new Error(typeof options.upstreamErrorMessage === "function" ? options.upstreamErrorMessage(data, text) : text);
      const elapsedMs = Date.now() - started;
      const usage = data.usage || {};
      const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
      return buildSample({ index, elapsedMs, ttftMs: 0, usage, outputTokens, content: data.choices?.[0]?.message?.content || "" });
    }
    if (!response.ok || !response.body?.getReader) {
      const text = await response.text();
      const data = parseJsonSafe(text, {});
      throw new Error(typeof options.upstreamErrorMessage === "function" ? options.upstreamErrorMessage(data, text) : text);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = {};
    let firstTokenAt = 0;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : lines.pop() || "";
      for (const line of lines) {
        const payload = line.trim().replace(/^data:\s*/, "");
        if (!payload || payload === "[DONE]") continue;
        const data = parseJsonSafe(payload, null);
        if (!data) continue;
        if (data.error) throw new Error(String(data.error.message || data.error || "Streaming benchmark request failed."));
        if (data.usage) usage = data.usage;
        const delta = data.choices?.[0]?.delta || {};
        const fragment = typeof delta.content === "string" ? delta.content : "";
        const reasoningFragment = typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : (typeof delta.reasoning === "string" ? delta.reasoning : "");
        if (!firstTokenAt && (fragment || reasoningFragment || delta.tool_calls)) firstTokenAt = Date.now();
        content += reasoningFragment;
        content += fragment;
      }
      if (done) break;
    }
    const elapsedMs = Date.now() - started;
    const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0) || Math.max(1, Math.ceil(content.length / 4));
    return buildSample({ index, elapsedMs, ttftMs: firstTokenAt ? firstTokenAt - started : elapsedMs, usage, outputTokens, content });
  }

  return {
    normalizeBenchmarkRequest,
    runBenchmarkJob,
  };
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function buildSample({ index, elapsedMs, ttftMs, usage = {}, outputTokens, content }) {
  const decodeMs = Math.max(1, elapsedMs - Number(ttftMs || 0));
  return {
    index,
    elapsedMs,
    ttftMs: Number(ttftMs || 0),
    promptTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens,
    tokensPerSecond: outputTokens ? outputTokens / (decodeMs / 1000) : 0,
    endToEndTokensPerSecond: outputTokens ? outputTokens / (elapsedMs / 1000) : 0,
    preview: String(content || "").slice(0, 240),
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * quantile) - 1))];
}

module.exports = {
  createBenchmarkRunner,
};
