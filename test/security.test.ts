import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { checkGenerationJob, empiriolabsTools, generateImage, generateVideo, textToSpeech } from "../src/index.js";
import { CATALOG, CDN, TEST_KEY, bytes, catalogRoute, createFetch, json, rejection, run } from "./helpers.js";

const PROXY = "https://proxy.example.com/v1";

function exposed(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.includes(TEST_KEY) || text.includes("unit-test-key");
}

function errorText(error: Error): string {
  return [error.message, error.stack ?? "", JSON.stringify(error), String(error)].join("\n");
}

describe("where the key goes", () => {
  it("sends the key only to the configured base URL, and never to the catalog", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${PROXY}/models`, () => json({ data: CATALOG })],
      ["POST", `${PROXY}/images/generations`, json({ data: [{ url: `${CDN}/a.png` }] })],
      ["POST", `${PROXY}/videos/generations`, json({ job_id: "v1", status: "processing" })],
      ["GET", `${PROXY}/jobs/v1`, json({ status: "completed", result: { data: [{ url: `${CDN}/v.mp4` }] } })],
    ]);
    const tools = empiriolabsTools({ apiKey: TEST_KEY, baseURL: `${PROXY}/`, fetch: fetchFn });
    await run(tools.generateImage, { prompt: "x", model: "m" });
    await run(tools.generateVideo, { prompt: "x", model: "m" });
    await run(tools.checkGenerationJob, { jobId: "v1" });
    await run(tools.findModels, { task: "image" });
    for (const call of calls) {
      expect(new URL(call.url).host).toBe("proxy.example.com");
      const authenticated = !call.url.endsWith("/models");
      expect(call.headers.get("authorization")).toBe(authenticated ? `Bearer ${TEST_KEY}` : null);
      if (authenticated) {
        expect(call.redirect).toBe("error");
      }
    }
  });

  it("never downloads the generated files it links to", async () => {
    const { fetchFn, calls } = createFetch([
      ["POST", /\/images\/generations$/u, json({ data: [{ url: `${CDN}/a.png` }, { url: `${CDN}/b.png` }] })],
    ]);
    await run(generateImage({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x", numberOfImages: 2 });
    expect(calls.map((call) => call.url)).toEqual(["https://api.empiriolabs.ai/v1/images/generations"]);
  });

  it("refuses a plain-http base URL for a remote host", () => {
    expect(() => generateImage({ apiKey: TEST_KEY, baseURL: "http://proxy.example.com/v1" })).toThrow(/https/u);
  });
});

describe("redirects", () => {
  it("refuses a redirect answer on a request that carries the key", async () => {
    const { fetchFn, calls } = createFetch([
      [
        "POST",
        /\/videos\/generations$/u,
        () => new Response(null, { status: 307, headers: { Location: "https://evil.example/steal" } }),
      ],
    ]);
    const error = await rejection(run(generateVideo({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x" }));
    expect(error.code).toBe("redirect_refused");
    expect(error.message).toContain("do not follow redirects");
    expect(calls).toHaveLength(1);
  });

  it("refuses a response that a custom fetch reached by following a redirect", async () => {
    const followed = json({ status: "completed" });
    Object.defineProperty(followed, "redirected", { value: true });
    const { fetchFn } = createFetch([["GET", /\/jobs\//u, () => followed]]);
    const error = await rejection(run(checkGenerationJob({ apiKey: TEST_KEY, fetch: fetchFn }), { jobId: "j1" }));
    expect(error.code).toBe("redirect_refused");
  });

  it("with Node's own fetch, the key never reaches the redirect target", async () => {
    vi.unstubAllGlobals();
    const reached: string[] = [];
    const target = http.createServer((request, response) => {
      reached.push(`${request.method} ${request.url} ${request.headers.authorization ?? "no key"}`);
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
    });
    const origin = http.createServer((_request, response) => {
      const port = (target.address() as AddressInfo).port;
      response.writeHead(307, { Location: `http://localhost:${port}/steal` });
      response.end();
    });
    await Promise.all([
      new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve)),
    ]);
    try {
      const baseURL = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/v1`;
      const job = await rejection(run(checkGenerationJob({ apiKey: TEST_KEY, baseURL }), { jobId: "job-1" }));
      const video = await rejection(run(generateVideo({ apiKey: TEST_KEY, baseURL, model: "m" }), { prompt: "x" }));
      expect(job.code).toBe("redirect_refused");
      expect(video.code).toBe("redirect_refused");
      expect(reached).toEqual([]);
    } finally {
      await Promise.all([
        new Promise((resolve) => target.close(resolve)),
        new Promise((resolve) => origin.close(resolve)),
      ]);
    }
  });
});

describe("the key never appears in errors or results", () => {
  it("redacts an API error that echoes the key", async () => {
    const { fetchFn } = createFetch([
      ["POST", /\/images\/generations$/u, json({ error: { message: `Invalid API key: ${TEST_KEY}` } }, 401)],
    ]);
    const error = await rejection(run(generateImage({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x" }));
    expect(error.status).toBe(401);
    expect(error.message).toBe(
      "EmpirioLabs AI API error (HTTP 401): Invalid API key: [redacted]. Check the API key. Keys are managed at " +
        "https://platform.empiriolabs.ai/dashboard/api-keys.",
    );
    expect(exposed(errorText(error))).toBe(false);
  });

  it("redacts the key read from the environment, and any other key-shaped string", async () => {
    vi.stubEnv("EMPIRIOLABS_API_KEY", TEST_KEY);
    const { fetchFn } = createFetch([
      [
        "POST",
        /\/videos\/generations$/u,
        json({ detail: `Bad key ${TEST_KEY}; also saw sk-empiriolabs-SomeoneElse_123` }, 403),
      ],
    ]);
    const error = await rejection(run(generateVideo({ fetch: fetchFn, model: "m" }), { prompt: "x" }));
    expect(exposed(errorText(error))).toBe(false);
    expect(error.message).toContain("Bad key [redacted]; also saw sk-empiriolabs-[redacted]");
  });

  it("redacts network errors", async () => {
    const { fetchFn } = createFetch([
      catalogRoute(),
      [
        "POST",
        /\/audio\/speech$/u,
        () => {
          throw new TypeError("fetch failed", { cause: new Error(`proxy rejected ${TEST_KEY}`) });
        },
      ],
    ]);
    const error = await rejection(run(textToSpeech({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { text: "hi" }));
    expect(error.code).toBe("network_error");
    expect(exposed(errorText(error))).toBe(false);
  });

  it("redacts failed jobs, thrown or returned", async () => {
    const failed = json({ status: "failed", error: { message: `upstream saw ${TEST_KEY}` } });
    const { fetchFn } = createFetch([
      ["POST", /\/videos\/generations$/u, json({ job_id: "v9", status: "processing" })],
      ["GET", /\/jobs\/v9$/u, () => failed.clone()],
    ]);
    const thrown = await rejection(run(generateVideo({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x" }));
    expect(exposed(errorText(thrown))).toBe(false);
    const returned = await run(checkGenerationJob({ apiKey: TEST_KEY, fetch: fetchFn }), { jobId: "v9" });
    expect(returned).toMatchObject({ status: "failed" });
    expect(exposed(returned)).toBe(false);
  });

  it("keeps the key out of every tool result", async () => {
    vi.stubEnv("EMPIRIOLABS_API_KEY", TEST_KEY);
    const { fetchFn } = createFetch([
      catalogRoute(),
      ["POST", /\/images\/generations$/u, json({ data: [{ url: `${CDN}/a.png` }] })],
      ["POST", /\/videos\/generations$/u, json({ job_id: "v2", status: "processing" })],
      ["GET", /\/jobs\/v2$/u, json({ status: "completed", result: { data: [{ url: `${CDN}/v.mp4` }] } })],
      ["POST", /\/audio\/speech$/u, () => bytes(new Uint8Array([1, 2, 3]), "audio/wav")],
      ["POST", /\/audio\/transcriptions$/u, json({ text: "hello" })],
    ]);
    const tools = empiriolabsTools({ fetch: fetchFn });
    const results = [
      await run(tools.generateImage, { prompt: "x" }),
      await run(tools.generateVideo, { prompt: "x" }),
      await run(tools.checkGenerationJob, { jobId: "v2" }),
      await run(tools.textToSpeech, { text: "hi" }),
      await run(tools.transcribeAudio, { audioUrl: "https://media.example.com/a.wav" }),
      await run(tools.findModels, { task: "speech" }),
    ];
    for (const result of results) {
      expect(exposed(result)).toBe(false);
    }
  });
});
