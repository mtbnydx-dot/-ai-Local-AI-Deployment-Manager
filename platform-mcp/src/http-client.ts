import { SERVER_VERSION } from "./constants.js";

export type JsonObject = Record<string, unknown>;

/**
 * Why an upstream call failed, recorded at the throw site so callers classify
 * on a discriminator instead of matching on the message text.
 */
export type UpstreamFailureReason =
  | "bad_shape"
  | "http_status"
  | "timeout"
  | "too_large"
  | "unreachable";

export class UpstreamRequestError extends Error {
  readonly service: string;
  readonly status: number;
  readonly reason: UpstreamFailureReason;

  constructor(service: string, message: string, status = 0, reason: UpstreamFailureReason = "http_status") {
    super(message);
    this.name = "UpstreamRequestError";
    this.service = service;
    this.status = status;
    this.reason = reason;
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
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`, 0, "bad_shape");
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
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`, 0, "bad_shape");
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
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`, 0, "bad_shape");
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
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const reason = timedOut ? `timed out after ${timeoutMs} ms` : "could not be reached";
      throw new UpstreamRequestError(
        service,
        `${service} ${reason}.`,
        0,
        timedOut ? "timeout" : "unreachable",
      );
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxResponseBytes) {
      throw new UpstreamRequestError(
        service,
        `${service} returned more data than the configured safety limit.`,
        response.status,
        "too_large",
      );
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
      throw new UpstreamRequestError(
        service,
        `${service} returned more data than the configured safety limit.`,
        response.status,
        "too_large",
      );
    }
    if (!response.ok) {
      throw new UpstreamRequestError(service, `${service} returned HTTP ${response.status}.`, response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UpstreamRequestError(service, `${service} returned invalid JSON.`, response.status, "bad_shape");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new UpstreamRequestError(service, `${service} returned an unexpected response shape.`, response.status, "bad_shape");
    }
    return parsed as JsonObject | unknown[];
  }
}
