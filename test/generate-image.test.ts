import { describe, expect, it, vi } from "vitest";
import { generateImage } from "../src/index.js";
import {
  API,
  CDN,
  TEST_KEY,
  catalogRoute,
  createFetch,
  json,
  rejection,
  run,
  sequence,
  settle,
} from "./helpers.js";

const IMAGES = `${API}/images/generations`;
const done = (urls: string[]) => () => json({ created: 1, data: urls.map((url) => ({ url })) });

type Schema = { safeParse(value: unknown): { success: boolean } };

describe("generateImage", () => {
  it("picks the catalog default and sends the documented request", async () => {
    const { fetchFn, calls } = createFetch([catalogRoute(), ["POST", IMAGES, done([`${CDN}/a.webp`])]]);
    const result = await run(generateImage({ apiKey: TEST_KEY, fetch: fetchFn }), { prompt: "a lighthouse at dawn" });
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe(IMAGES);
    expect(post.body).toEqual({
      model: "image-native",
      prompt: "a lighthouse at dawn",
      sync: true,
      response_format: "url",
    });
    expect(post.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(post.headers.get("content-type")).toBe("application/json");
    expect(post.redirect).toBe("error");
    expect(result).toEqual({
      status: "completed",
      model: "image-native",
      urls: [`${CDN}/a.webp`],
      note: "These links are signed and expire. Download any file you want to keep.",
    });
  });

  it("sends a model the call names exactly as given, without reading the catalog", async () => {
    const { fetchFn, calls } = createFetch([["POST", IMAGES, done([`${CDN}/a.png`])]]);
    await run(generateImage({ apiKey: TEST_KEY, fetch: fetchFn }), { prompt: "x", model: "Vendor/Custom-Model:v2" });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { model: string }).model).toBe("Vendor/Custom-Model:v2");
  });

  it("uses the configured model when the call names none, and the call's model over it", async () => {
    const { fetchFn, calls } = createFetch([["POST", IMAGES, done([`${CDN}/a.png`])]]);
    const tool = generateImage({ apiKey: TEST_KEY, fetch: fetchFn, model: "image-plain" });
    expect(tool.description).toContain("When model is omitted, image-plain is used.");
    await run(tool, { prompt: "x" });
    await run(tool, { prompt: "x", model: "image-featured" });
    expect(calls.map((call) => (call.body as { model: string }).model)).toEqual(["image-plain", "image-featured"]);
  });

  it("maps aspect ratio, size, image count, and reference images, and edits with an editing model", async () => {
    const { fetchFn, calls } = createFetch([catalogRoute(), ["POST", IMAGES, done([`${CDN}/1.png`, `${CDN}/2.png`])]]);
    const result = await run(generateImage({ apiKey: TEST_KEY, fetch: fetchFn }), {
      prompt: "make the sky stormy",
      aspectRatio: "16:9",
      size: "1024x576",
      numberOfImages: 2,
      referenceImageUrls: ["https://images.example.com/photo.jpg"],
    });
    expect(calls.find((call) => call.method === "POST")!.body).toEqual({
      model: "image-editor",
      prompt: "make the sky stormy",
      sync: true,
      response_format: "url",
      aspect_ratio: "16:9",
      size: "1024x576",
      num_images: 2,
      image: ["https://images.example.com/photo.jpg"],
    });
    expect(result).toMatchObject({ status: "completed", urls: [`${CDN}/1.png`, `${CDN}/2.png`] });
  });

  it("waits for the job when the image is not ready in the response", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      ["POST", IMAGES, json({ job_id: "img-1", status: "processing" }, 202)],
      [
        "GET",
        `${API}/jobs/img-1`,
        sequence(
          () => json({ job_id: "img-1", status: "processing" }),
          () => json({ job_id: "img-1", status: "completed", result: { data: [{ url: `${CDN}/late.webp` }] } }),
        ),
      ],
    ]);
    const tool = generateImage({ apiKey: TEST_KEY, fetch: fetchFn, model: "image-plain" });
    const result = await settle(run(tool, { prompt: "x" }));
    expect(result).toMatchObject({ status: "completed", jobId: "img-1", urls: [`${CDN}/late.webp`] });
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("returns the job ID with status processing when the job outlasts the wait", async () => {
    vi.useFakeTimers();
    const { fetchFn } = createFetch([
      ["POST", IMAGES, json({ job_id: "img-2", status: "processing" })],
      ["GET", `${API}/jobs/img-2`, () => json({ job_id: "img-2", status: "processing" })],
    ]);
    const tool = generateImage({ apiKey: TEST_KEY, fetch: fetchFn, model: "image-plain", waitTimeoutMs: 10_000 });
    const result = await settle(run(tool, { prompt: "x" }));
    expect(result).toEqual({
      status: "processing",
      model: "image-plain",
      jobId: "img-2",
      message:
        "The image is not ready yet. Call checkGenerationJob with this jobId later to get it. Sending the request " +
        "again would start and bill a new job.",
    });
  });

  it("throws the job's own error when the job fails", async () => {
    const { fetchFn } = createFetch([
      ["POST", IMAGES, json({ job_id: "img-3", status: "processing" })],
      [
        "GET",
        `${API}/jobs/img-3`,
        json({ status: "failed", error: { message: "The prompt was rejected by the safety filter.", code: "content_policy" } }),
      ],
    ]);
    const error = await rejection(
      run(generateImage({ apiKey: TEST_KEY, fetch: fetchFn, model: "image-plain" }), { prompt: "x" }),
    );
    expect(error.message).toBe("Image job img-3 failed: The prompt was rejected by the safety filter.");
    expect(error.code).toBe("content_policy");
    expect(error.jobId).toBe("img-3");
  });

  it("reports a finished request that returned no image", async () => {
    const { fetchFn } = createFetch([["POST", IMAGES, json({ created: 1, data: [] })]]);
    const error = await rejection(run(generateImage({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x" }));
    expect(error.code).toBe("no_output");
  });

  it("gives inline image data to the application and only its size to the model", async () => {
    const { fetchFn } = createFetch([
      ["POST", IMAGES, json({ data: [{ b64_json: "data:image/png;base64,aGVsbG8=" }] })],
    ]);
    const tool = generateImage({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" });
    const result = await run(tool, { prompt: "x" });
    expect(result).toEqual({
      status: "completed",
      model: "m",
      urls: [],
      inline: [{ base64: "aGVsbG8=", mediaType: "image/png" }],
      note: "The file data was returned directly to the application, so there is no link to download.",
    });
    const forModel = await tool.toModelOutput!({ toolCallId: "1", input: { prompt: "x" }, output: result });
    expect(JSON.stringify(forModel)).not.toContain("aGVsbG8=");
    expect(forModel).toMatchObject({ type: "json", value: { inline: [{ mediaType: "image/png", bytes: 5 }] } });
  });

  it("validates its input", () => {
    const schema = generateImage({ apiKey: TEST_KEY }).inputSchema as unknown as Schema;
    expect(schema.safeParse({ prompt: "x" }).success).toBe(true);
    expect(schema.safeParse({ prompt: "" }).success).toBe(false);
    expect(schema.safeParse({ prompt: "x", numberOfImages: 5 }).success).toBe(false);
    expect(schema.safeParse({ prompt: "x", numberOfImages: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ prompt: "x", referenceImageUrls: ["http://images.example.com/a.png"] }).success).toBe(false);
    expect(schema.safeParse({ prompt: "x", referenceImageUrls: ["photo.png"] }).success).toBe(false);
    expect(schema.safeParse({ prompt: "x", referenceImageUrls: ["https://images.example.com/a.png"] }).success).toBe(true);
  });
});
