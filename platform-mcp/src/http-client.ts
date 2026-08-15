export type JsonObject = Record<string, unknown>;

export class UpstreamRequestError extends Error {
  readonly service: string;
  readonly status: number;

  constructor(service: string, message: string, status = 0) {
    super(message);
    this.name = "UpstreamRequestError";
    this.service = service;
    this.status = status;
  }
}

export type FixedHttpClientOptions = {
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
};

export class FixedHttpClient {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FixedHttpClientOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxResponseBytes = options.maxResponseBytes;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getJson(service: string, baseUrl: URL, relativePath: string): Promise<JsonObject> {
    if (!relativePath.startsWith("/") || relativePath.startsWith("//")) {
      throw new Error("Internal upstream paths must be absolute path references.");
    }
    const url = new URL(relativePath, baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new Error("Internal upstream path changed the configured origin.");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "local-ai-platform-mcp-server/0.1.0",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? `timed out after ${this.timeoutMs} ms`
        : "could not be reached";
      throw new UpstreamRequestError(service, `${service} ${reason}.`);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > this.maxResponseBytes) {
      throw new UpstreamRequestError(service, `${service} returned more data than the configured safety limit.`, response.status);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > this.maxResponseBytes) {
      throw new UpstreamRequestError(service, `${service} returned more data than the configured safety limit.`, response.status);
    }
    if (!response.ok) {
      throw new UpstreamRequestError(service, `${service} returned HTTP ${response.status}.`, response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UpstreamRequestError(service, `${service} returned invalid JSON.`, response.status);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`, response.status);
    }
    return parsed as JsonObject;
  }
}
