/**
 * HTTP client for the EmpirioLabs AI API.
 *
 * The API key is attached only to requests for the configured base URL, a
 * request that carries the key never follows a redirect, and no error message
 * contains the key. GET requests retry on rate limits, server errors, and
 * network errors. POST requests retry only when the API answers 429, because a
 * request that failed in flight may already have been processed and billed.
 */
import {
  API_KEY_ENV_VAR,
  API_KEYS_URL,
  BILLING_URL,
  BRAND,
  DEFAULT_BASE_URL,
  USER_AGENT,
} from "./constants.js";
import { EmpirioLabsError, abortReason, redact } from "./errors.js";

export type FetchFunction = typeof globalThis.fetch;

/** Connection settings shared by every tool. */
export type EmpirioLabsClientOptions = {
  /**
   * EmpirioLabs AI API key. Defaults to the `EMPIRIOLABS_API_KEY` environment
   * variable, read when a tool runs.
   */
  apiKey?: string;
  /**
   * API base URL, including `/v1`. Defaults to `https://api.empiriolabs.ai/v1`.
   * The API key is sent only to this host.
   */
  baseURL?: string;
  /** Custom fetch implementation, for example for a proxy or for tests. Defaults to the global fetch. */
  fetch?: FetchFunction;
};

/** A successful API response. */
export type ApiResponse = {
  status: number;
  /** Lower-cased media type without parameters, for example `application/json`. */
  contentType: string;
  body: Uint8Array;
};

export type RequestOptions = {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
};

type SendOptions = RequestOptions & {
  method: "GET" | "POST";
  path: string;
  auth: boolean;
  json?: unknown;
  accept?: string;
  maxBytes?: number;
};

type Attempt =
  | { ok: true; status: number; statusText: string; headers: Headers; contentType: string; body: Uint8Array }
  | { ok: false; error: unknown; timedOut: boolean };

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const GET_ATTEMPTS = 4;
const POST_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_JSON_BYTES = 16 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const ERROR_HINTS: Record<number, string> = {
  401: `Check the API key. Keys are managed at ${API_KEYS_URL}.`,
  402: `Add credits at ${BILLING_URL}, then try again.`,
  404: "Check the model ID or job ID. findModels lists the available models.",
  413: "The input is too large.",
  429: "Too many requests right now. Wait a moment and try again.",
};

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

/** Validates a base URL and returns it without a trailing slash. */
export function normalizeBaseURL(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmpirioLabsError("baseURL is not a valid URL.", { code: "invalid_base_url" });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new EmpirioLabsError("baseURL must not contain credentials, a query, or a fragment.", {
      code: "invalid_base_url",
    });
  }
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new EmpirioLabsError("baseURL must use https. Plain http is accepted only for localhost.", {
      code: "invalid_base_url",
    });
  }
  return url.toString().replace(/\/+$/u, "");
}

/** Reads the error message from an API error body: `error.message`, `detail`, or `message`. */
export function extractErrorMessage(
  body: Uint8Array | string,
  fallback: string,
): { message: string; code?: string; type?: string } {
  const text = (typeof body === "string" ? body : new TextDecoder().decode(body)).trim();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  let message: string | undefined;
  let code: string | undefined;
  let type: string | undefined;
  if (isRecord(payload)) {
    const error = payload.error;
    if (isRecord(error)) {
      message = nonEmpty(error.message);
      code = scalar(error.code);
      type = nonEmpty(error.type);
    } else {
      message = nonEmpty(error);
    }
    const detail = payload.detail;
    if (!message && typeof detail === "string") {
      message = nonEmpty(detail);
    } else if (!message && isRecord(detail)) {
      message = nonEmpty(detail.message) ?? nonEmpty(detail.detail);
    } else if (!message && Array.isArray(detail) && detail.length > 0) {
      const first: unknown = detail[0];
      if (isRecord(first)) {
        const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : undefined;
        const msg = nonEmpty(first.msg);
        message = msg && (typeof field === "string" || typeof field === "number") ? `${field}: ${msg}` : msg;
      } else {
        message = String(first);
      }
    }
    if (!message) {
      message = nonEmpty(payload.message);
    }
  }
  if (!message) {
    message = text && !text.startsWith("<") ? text.slice(0, 300) : fallback.trim() || "Request failed";
  }
  return { message, ...(code ? { code } : {}), ...(type ? { type } : {}) };
}

/** Sends requests to the EmpirioLabs AI API. */
export class ApiClient {
  readonly baseURL: string;
  readonly host: string;
  private readonly origin: string;
  private readonly fetchFn: FetchFunction;
  private readonly explicitKey: string | undefined;

  constructor(options: EmpirioLabsClientOptions = {}) {
    this.baseURL = normalizeBaseURL(options.baseURL);
    const parsed = new URL(this.baseURL);
    this.origin = parsed.origin;
    this.host = parsed.host;
    const custom = options.fetch;
    if (custom !== undefined && typeof custom !== "function") {
      throw new EmpirioLabsError("fetch must be a function.", { code: "invalid_fetch" });
    }
    // Called unbound: some runtimes reject fetch called with another `this`.
    this.fetchFn = custom ?? ((input, init) => globalThis.fetch(input, init));
    this.explicitKey = options.apiKey?.trim() || undefined;
  }

  private apiKey(): string | undefined {
    return this.explicitKey ?? (readEnv(API_KEY_ENV_VAR)?.trim() || undefined);
  }

  /** Throws a clear error when no API key is configured. */
  requireApiKey(): string {
    const key = this.apiKey();
    if (!key) {
      throw new EmpirioLabsError(
        `${API_KEY_ENV_VAR} is not set. Create an API key at ${API_KEYS_URL} and set it as the ` +
          `${API_KEY_ENV_VAR} environment variable, or pass apiKey when you create the tools.`,
        { code: "missing_api_key" },
      );
    }
    return key;
  }

  /** Text with the API key, and anything shaped like a key, removed. */
  redact(text: string): string {
    return redact(text, [this.explicitKey, readEnv(API_KEY_ENV_VAR)]);
  }

  url(path: string): string {
    return this.baseURL + (path.startsWith("/") ? path : `/${path}`);
  }

  async getJson<T>(path: string, options: RequestOptions & { auth: boolean }): Promise<T> {
    const response = await this.send({ ...options, method: "GET", path });
    return this.parseJson<T>(response);
  }

  async postJson<T>(path: string, json: unknown, options: RequestOptions = {}): Promise<T> {
    const response = await this.send({ ...options, method: "POST", path, auth: true, json });
    return this.parseJson<T>(response);
  }

  /** A POST whose answer may be JSON or raw bytes (`accept` defaults to any type). */
  async post(path: string, json: unknown, options: RequestOptions & { accept?: string; maxBytes?: number } = {}): Promise<ApiResponse> {
    return this.send({ accept: "*/*", ...options, method: "POST", path, auth: true, json });
  }

  parseJson<T>(response: ApiResponse): T {
    try {
      return JSON.parse(new TextDecoder().decode(response.body)) as T;
    } catch {
      throw new EmpirioLabsError(`${BRAND} returned a response that is not valid JSON.`, {
        status: response.status,
        code: "invalid_response",
      });
    }
  }

  private async send(options: SendOptions): Promise<ApiResponse> {
    const url = this.url(options.path);
    const headers: Record<string, string> = {
      Accept: options.accept ?? "application/json",
      "User-Agent": USER_AGENT,
    };
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["Content-Type"] = "application/json";
    }
    if (options.auth) {
      if (new URL(url).origin !== this.origin) {
        throw new EmpirioLabsError("Refusing to send the API key outside the configured base URL.", {
          code: "foreign_host",
        });
      }
      headers.Authorization = `Bearer ${this.requireApiKey()}`;
    }
    const idempotent = options.method === "GET";
    const attempts = idempotent ? GET_ATTEMPTS : POST_ATTEMPTS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const init: RequestInit = {
      method: options.method,
      headers,
      redirect: options.auth ? "error" : "follow",
      ...(body !== undefined ? { body } : {}),
    };
    for (let attempt = 1; ; attempt += 1) {
      if (options.signal?.aborted) {
        throw abortReason(options.signal);
      }
      const result = await this.attempt(url, init, options, timeoutMs);
      if (result.ok) {
        if (result.status >= 200 && result.status < 300) {
          return { status: result.status, contentType: result.contentType, body: result.body };
        }
        const retryable = result.status === 429 || (idempotent && RETRY_STATUSES.has(result.status));
        if (retryable && attempt < attempts) {
          await sleep(retryAfterMs(result.headers, attempt), options.signal);
          continue;
        }
        throw this.apiError(result.status, result.body, result.statusText);
      }
      if (result.error instanceof EmpirioLabsError) {
        throw result.error;
      }
      if (options.signal?.aborted) {
        throw abortReason(options.signal);
      }
      const reason = describeError(result.error);
      if (options.auth && /redirect/iu.test(reason)) {
        throw redirectRefused();
      }
      if (idempotent && attempt < attempts) {
        await sleep(Math.min(2 ** attempt, 20) * 1000, options.signal);
        continue;
      }
      let message = result.timedOut
        ? `${BRAND} did not answer within ${Math.round(timeoutMs / 1000)} s.`
        : `Could not reach ${this.host}: ${reason}.`;
      if (!idempotent) {
        message += " The request may still have been processed, so check before sending it again.";
      }
      throw new EmpirioLabsError(this.redact(message), { code: result.timedOut ? "timeout" : "network_error" });
    }
  }

  private async attempt(url: string, init: RequestInit, options: SendOptions, timeoutMs: number): Promise<Attempt> {
    const timer = startTimer(options.signal, timeoutMs);
    try {
      const fetchFn = this.fetchFn;
      const response = await fetchFn(url, { ...init, signal: timer.signal });
      if (options.auth && isRedirect(response)) {
        await response.body?.cancel().catch(() => undefined);
        throw redirectRefused(response.status);
      }
      const body = await readBody(response, options.maxBytes ?? MAX_JSON_BYTES);
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        contentType: mediaType(response.headers.get("content-type")),
        body,
      };
    } catch (error) {
      return { ok: false, error, timedOut: timer.timedOut() };
    } finally {
      timer.clear();
    }
  }

  private apiError(status: number, body: Uint8Array, statusText: string): EmpirioLabsError {
    const { message, code, type } = extractErrorMessage(body, statusText);
    let text = `${BRAND} API error (HTTP ${status}): ${message}`;
    const hint = ERROR_HINTS[status];
    if (hint && !message.includes("platform.empiriolabs.ai")) {
      text += `${/[.!?]$/u.test(text) ? "" : "."} ${hint}`;
    }
    return new EmpirioLabsError(this.redact(text), {
      status,
      ...(code ? { code } : {}),
      ...(type ? { type } : {}),
    });
  }
}

function redirectRefused(status?: number): EmpirioLabsError {
  return new EmpirioLabsError(
    `${BRAND} answered with a redirect. Requests that carry the API key do not follow redirects; check baseURL.`,
    { code: "redirect_refused", ...(status ? { status } : {}) },
  );
}

function isRedirect(response: Response): boolean {
  return (
    response.type === "opaqueredirect" ||
    response.redirected === true ||
    (response.status >= 300 && response.status < 400)
  );
}

function mediaType(value: string | null): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

async function readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new EmpirioLabsError(`The response from ${BRAND} is larger than ${maxBytes} bytes.`, {
      status: response.status,
      code: "response_too_large",
    });
  }
  if (!response.body) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new EmpirioLabsError(`The response from ${BRAND} is larger than ${maxBytes} bytes.`, {
          status: response.status,
          code: "response_too_large",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function retryAfterMs(headers: Headers, attempt: number): number {
  const value = Number(headers.get("retry-after"));
  if (headers.get("retry-after") !== null && Number.isFinite(value)) {
    return Math.max(0.5, Math.min(value, 30)) * 1000;
  }
  return Math.min(2 ** attempt, 20) * 1000;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return cause.message;
    }
    return error.message || error.name;
  }
  return String(error);
}

function startTimer(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent ? abortReason(parent) : undefined);
  if (parent) {
    if (parent.aborted) {
      onAbort();
    } else {
      parent.addEventListener("abort", onAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The request timed out.", "TimeoutError"));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/** Waits `ms`, or rejects with the abort reason as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Base64 of raw bytes, without depending on Node's Buffer. */
export function toBase64(bytes: Uint8Array): string {
  const NodeBuffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } })
    .Buffer;
  if (NodeBuffer) {
    return NodeBuffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return nonEmpty(value);
}
