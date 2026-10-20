import { describe, expect, it, vi } from "vitest";
import { ApiClient, extractErrorMessage, normalizeBaseURL } from "../src/http.js";
import { API, type RecordedCall, TEST_KEY, createFetch, json, rejection, sequence, settle } from "./helpers.js";

const hang = (call: RecordedCall) =>
  new Promise<Response>((_, reject) => {
    call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
  });

describe("base URL", () => {
  it("defaults to the EmpirioLabs AI API", () => {
    expect(normalizeBaseURL(undefined)).toBe(API);
    expect(normalizeBaseURL("  ")).toBe(API);
  });

  it("drops a trailing slash", () => {
    expect(normalizeBaseURL("https://proxy.example.com/v1/")).toBe("https://proxy.example.com/v1");
  });

  it("accepts plain http only for localhost", () => {
    expect(normalizeBaseURL("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(normalizeBaseURL("http://127.0.0.1:9/v1")).toBe("http://127.0.0.1:9/v1");
    expect(() => normalizeBaseURL("http://proxy.example.com/v1")).toThrow(/must use https/u);
  });

  it("rejects invalid URLs, credentials, queries, and fragments", () => {
    expect(() => normalizeBaseURL("not a url")).toThrow(/not a valid URL/u);
    expect(() => normalizeBaseURL("https://user:pass@proxy.example.com/v1")).toThrow(/credentials/u);
    expect(() => normalizeBaseURL("https://proxy.example.com/v1?x=1")).toThrow(/query/u);
    expect(() => normalizeBaseURL("https://proxy.example.com/v1#top")).toThrow(/fragment/u);
  });
});

describe("API key", () => {
  it("reads EMPIRIOLABS_API_KEY when a request is sent, not when the client is made", async () => {
    const { fetchFn, calls } = createFetch([["GET", `${API}/jobs/1`, json({ status: "processing" })]]);
    const client = new ApiClient({ fetch: fetchFn });
    vi.stubEnv("EMPIRIOLABS_API_KEY", TEST_KEY);
    await client.getJson("/jobs/1", { auth: true });
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  it("prefers the apiKey option over the environment", async () => {
    vi.stubEnv("EMPIRIOLABS_API_KEY", "sk-empiriolabs-from-the-environment");
    const { fetchFn, calls } = createFetch([["GET", `${API}/jobs/1`, json({})]]);
    await new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn }).getJson("/jobs/1", { auth: true });
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  it("fails with a clear message before any request when no key is set", async () => {
    const { fetchFn, calls } = createFetch([]);
    const error = await rejection(new ApiClient({ fetch: fetchFn }).getJson("/jobs/1", { auth: true }));
    expect(error.code).toBe("missing_api_key");
    expect(error.message).toContain("EMPIRIOLABS_API_KEY is not set");
    expect(error.message).toContain("https://platform.empiriolabs.ai/dashboard/api-keys");
    expect(calls).toHaveLength(0);
  });

  it("sends no key on unauthenticated requests", async () => {
    const { fetchFn, calls } = createFetch([["GET", `${API}/models`, json({ data: [] })]]);
    await new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn }).getJson("/models", { auth: false });
    expect(calls[0]!.headers.has("authorization")).toBe(false);
    expect(calls[0]!.headers.get("user-agent")).toBe("@empiriolabs/ai-sdk/0.1.0");
  });
});

describe("error messages", () => {
  const read = (body: unknown, fallback = "Bad Request") =>
    extractErrorMessage(typeof body === "string" ? body : JSON.stringify(body), fallback);

  it("reads the error envelope with its code and type", () => {
    expect(read({ error: { message: "Insufficient credits", code: "insufficient_quota", type: "billing_error" } })).toEqual({
      message: "Insufficient credits",
      code: "insufficient_quota",
      type: "billing_error",
    });
  });

  it("reads string errors, detail strings, detail objects, and validation lists", () => {
    expect(read({ error: "Model not found" }).message).toBe("Model not found");
    expect(read({ detail: "Job not found" }).message).toBe("Job not found");
    expect(read({ detail: { message: "Too large" } }).message).toBe("Too large");
    expect(read({ detail: [{ loc: ["body", "prompt"], msg: "Field required" }] }).message).toBe("prompt: Field required");
    expect(read({ message: "Rate limited" }).message).toBe("Rate limited");
  });

  it("falls back to plain text, and never to an HTML page", () => {
    expect(read("upstream said no").message).toBe("upstream said no");
    expect(read("<html><body>502</body></html>", "Bad Gateway").message).toBe("Bad Gateway");
    expect(read("", "").message).toBe("Request failed");
  });

  it("carries the API's message, status, and code, plus the next step", async () => {
    const { fetchFn } = createFetch([
      [
        "POST",
        `${API}/images/generations`,
        json({ error: { message: "Insufficient credits", code: "insufficient_quota", type: "billing_error" } }, 402),
      ],
    ]);
    const error = await rejection(new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn }).postJson("/images/generations", {}));
    expect(error.name).toBe("EmpirioLabsError");
    expect(error.status).toBe(402);
    expect(error.code).toBe("insufficient_quota");
    expect(error.type).toBe("billing_error");
    expect(error.message).toBe(
      "EmpirioLabs AI API error (HTTP 402): Insufficient credits. Add credits at " +
        "https://platform.empiriolabs.ai/dashboard/billing, then try again.",
    );
  });

  it("rejects a success response that is not JSON", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, new Response("not json", { status: 200 })]]);
    const error = await rejection(new ApiClient({ fetch: fetchFn }).getJson("/models", { auth: false }));
    expect(error.code).toBe("invalid_response");
  });
});

describe("retries", () => {
  it("retries a GET after a server error, honouring Retry-After", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      [
        "GET",
        `${API}/jobs/1`,
        sequence(
          () => json({ error: { message: "busy" } }, 503, { "Retry-After": "3" }),
          () => json({ status: "completed" }),
        ),
      ],
    ]);
    const client = new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn });
    const job = await settle(client.getJson<{ status: string }>("/jobs/1", { auth: true }));
    expect(job.status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBe(3000);
  });

  it("retries a GET after a network error", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { fetchFn, calls } = createFetch([
      [
        "GET",
        `${API}/models`,
        () => {
          attempts += 1;
          if (attempts === 1) {
            throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
          }
          return json({ data: [] });
        },
      ],
    ]);
    await settle(new ApiClient({ fetch: fetchFn }).getJson("/models", { auth: false }));
    expect(calls).toHaveLength(2);
  });

  it("gives up on a GET after four attempts", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([["GET", `${API}/models`, () => json({ error: "down" }, 502)]]);
    const error = await rejection(settle(new ApiClient({ fetch: fetchFn }).getJson("/models", { auth: false })));
    expect(error.status).toBe(502);
    expect(calls).toHaveLength(4);
  });

  it("never retries a POST after a server error, because it may have been processed", async () => {
    const { fetchFn, calls } = createFetch([["POST", `${API}/videos/generations`, json({ error: "boom" }, 500)]]);
    const error = await rejection(new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn }).postJson("/videos/generations", {}));
    expect(error.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("retries a POST after a 429, which the API answers before doing any work", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      [
        "POST",
        `${API}/videos/generations`,
        sequence(
          () => json({ error: { message: "Rate limit reached" } }, 429, { "Retry-After": "1" }),
          () => json({ job_id: "v1", status: "processing" }),
        ),
      ],
    ]);
    const client = new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn });
    const body = await settle(client.postJson<{ job_id: string }>("/videos/generations", { model: "m" }));
    expect(body.job_id).toBe("v1");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ model: "m" });
  });

  it("reports the 429 with a next step once the retries run out", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      ["POST", `${API}/videos/generations`, () => json({ error: { message: "Rate limit reached" } }, 429)],
    ]);
    const client = new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn });
    const error = await rejection(settle(client.postJson("/videos/generations", {})));
    expect(calls).toHaveLength(3);
    expect(error.message).toBe(
      "EmpirioLabs AI API error (HTTP 429): Rate limit reached. Too many requests right now. Wait a moment and try again.",
    );
  });

  it("does not retry a POST after a network error, and says it may have been processed", async () => {
    const { fetchFn, calls } = createFetch([
      [
        "POST",
        `${API}/videos/generations`,
        () => {
          throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
        },
      ],
    ]);
    const error = await rejection(new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn }).postJson("/videos/generations", {}));
    expect(error.code).toBe("network_error");
    expect(error.message).toBe(
      "Could not reach api.empiriolabs.ai: socket hang up. The request may still have been processed, so check before " +
        "sending it again.",
    );
    expect(calls).toHaveLength(1);
  });

  it("times out a request that does not answer", async () => {
    vi.useFakeTimers();
    const { fetchFn } = createFetch([["POST", `${API}/audio/speech`, hang]]);
    const client = new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn });
    const error = await rejection(settle(client.postJson("/audio/speech", {}, { timeoutMs: 2_000 })));
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("EmpirioLabs AI did not answer within 2 s.");
  });
});

describe("cancellation", () => {
  it("stops a request as soon as the caller aborts", async () => {
    const { fetchFn, calls } = createFetch([["POST", `${API}/audio/speech`, hang]]);
    const controller = new AbortController();
    const pending = new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn }).postJson("/audio/speech", {}, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    const error = await rejection(pending);
    expect(error.name).toBe("AbortError");
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("sends nothing when the signal is already aborted", async () => {
    const { fetchFn, calls } = createFetch([]);
    const error = await rejection(
      new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn }).postJson("/audio/speech", {}, { signal: AbortSignal.abort() }),
    );
    expect(error.name).toBe("AbortError");
    expect(calls).toHaveLength(0);
  });
});
