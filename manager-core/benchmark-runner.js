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
    return {
      port: Number(input.port || defaultPort),
      model: String(input.model || "").trim(),
      requests: Math.min(5, Math.max(1, Number(input.requests || 3))),
      maxTokens: Math.min(1024, Math.max(16, Number(input.maxTokens || 160))),
      prompt: String(input.prompt || defaultPrompt),
    };
  }

  async function runBenchmarkJob(job, input = {}) {
    const config = normalizeBenchmarkRequest(input);
    const runtime = await options.getRunningModelSummary();
    const model = config.model || runtime.models?.[0]?.id;
    if (!runtime.container?.running || !model) throw new Error(`No running ${runtimeLabel} model is available for benchmark.`);
    const port = Number(config.port || runtime.endpoint?.port || defaultPort);
    const samples = [];
    for (let index = 0; index < config.requests; index += 1) {
      options.setJobProgress?.(job, {
        percent: Math.round((index / config.requests) * 90),
        stage: `Benchmark ${index + 1}/${config.requests}`,
        detail: requestDetail,
      });
      const started = Date.now();
      const headers = {
        "content-type": "application/json",
        ...(typeof options.getHeaders === "function" ? options.getHeaders(runtime) : {}),
      };
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: config.prompt }],
          temperature: 0,
          max_tokens: config.maxTokens,
        }),
        signal: AbortSignal.timeout(Number(options.timeoutMs || 180000)),
      });
      const text = await response.text();
      const elapsedMs = Date.now() - started;
      const data = parseJsonSafe(text, {});
      if (!response.ok) throw new Error(typeof options.upstreamErrorMessage === "function" ? options.upstreamErrorMessage(data, text) : text);
      const usage = data.usage || {};
      const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
      samples.push({
        elapsedMs,
        promptTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
        outputTokens,
        tokensPerSecond: outputTokens ? outputTokens / (elapsedMs / 1000) : 0,
        preview: String(data.choices?.[0]?.message?.content || "").slice(0, 240),
      });
      options.appendLog?.(job, `Run ${index + 1}: ${elapsedMs} ms, ${outputTokens} output tokens.`);
    }
    const avgMs = samples.reduce((sum, item) => sum + item.elapsedMs, 0) / samples.length;
    const avgTps = samples.reduce((sum, item) => sum + item.tokensPerSecond, 0) / samples.length;
    options.setJobProgress?.(job, { percent: 100, stage: "Benchmark complete", detail: `${avgTps.toFixed(2)} tok/s average`, state: "ok" });
    options.finishJob?.(job, {
      benchmark: {
        model,
        port,
        requests: config.requests,
        maxTokens: config.maxTokens,
        avgMs,
        avgTokensPerSecond: avgTps,
        samples,
      },
    });
    return { model, port, requests: config.requests, maxTokens: config.maxTokens, avgMs, avgTokensPerSecond: avgTps, samples };
  }

  return {
    normalizeBenchmarkRequest,
    runBenchmarkJob,
  };
}

module.exports = {
  createBenchmarkRunner,
};
