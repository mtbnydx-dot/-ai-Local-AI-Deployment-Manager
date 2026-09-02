import { SERVER_VERSION } from "./constants.js";

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

export type InternalRequestOptions = {
  bearerToken?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
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

  async getJson(
    service: string,
    baseUrl: URL,
    relativePath: string,
    options: InternalRequestOptions = {},
  ): Promise<JsonObject> {
    const parsed = await this.requestJsonValue(service, baseUrl, relativePath, "GET", undefined, options);
    if (Array.isArray(parsed)) {
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`);
    }
    return parsed;
  }

  async getJsonArray(
    service: string,
    baseUrl: URL,
    relativePath: string,
    options: InternalRequestOptions = {},
  ): Promise<unknown[]> {
    const parsed = await this.requestJsonValue(service, baseUrl, relativePath, "GET", undefined, options);
    if (!Array.isArray(parsed)) {
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`);
    }
    return parsed;
  }

  async postJson(
    service: string,
    baseUrl: URL,
    relativePath: string,
    body: JsonObject,
    options: InternalRequestOptions = {},
  ): Promise<JsonObject> {
    const parsed = await this.requestJsonValue(service, baseUrl, relativePath, "POST", body, options);
    if (Array.isArray(parsed)) {
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`);
    }
    return parsed;
  }

  private async requestJsonValue(
    service: string,
    baseUrl: URL,
    relativePath: string,
    method: "GET" | "POST",
    body: JsonObject | undefined,
    options: InternalRequestOptions,
  ): Promise<JsonObject | unknown[]> {
    if (!relativePath.startsWith("/") || relativePath.startsWith("//")) {
      throw new Error("Internal upstream paths must be absolute path references.");
    }
    const url = new URL(relativePath, baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new Error("Internal upstream path changed the configured origin.");
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `local-ai-platform-mcp-server/${SERVER_VERSION}`,
    };
    if (method === "POST") headers["content-type"] = "application/json";
    if (options.bearerToken) headers.authorization = `Bearer ${options.bearerToken}`;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxResponseBytes = options.maxResponseBytes ?? this.maxResponseBytes;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? `timed out after ${timeoutMs} ms`
        : "could not be reached";
      throw new UpstreamRequestError(service, `${service} ${reason}.`);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxResponseBytes) {
      throw new UpstreamRequestError(service, `${service} returned more data than the configured safety limit.`, response.status);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
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
    if (!parsed || typeof parsed !== "object") {
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`, response.status);
    }
    return parsed as JsonObject | unknown[];
  }
}
