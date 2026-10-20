import { describe, expect, it, vi } from "vitest";
import { textToSpeech } from "../src/index.js";
import {
  API,
  CDN,
  TEST_KEY,
  bytes,
  catalogRoute,
  createFetch,
  json,
  rejection,
  run,
  sequence,
  settle,
} from "./helpers.js";

const SPEECH = `${API}/audio/speech`;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21]);

describe("textToSpeech", () => {
  it("returns the hosted link from a JSON answer, with the model's own spelling of the format", async () => {
    const { fetchFn, calls } = createFetch([
      catalogRoute(),
      ["POST", SPEECH, json({ data: [{ url: `${CDN}/speech.mp3`, content_type: "audio/mpeg" }] })],
    ]);
    const result = await run(textToSpeech({ apiKey: TEST_KEY, fetch: fetchFn }), {
      text: "Welcome to the weekly update.",
      voice: "Olivia",
      format: "mp3",
    });
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({
      model: "voice-one",
      input: "Welcome to the weekly update.",
      voice: "Olivia",
      output_format: "MP3",
    });
    expect(post.headers.get("accept")).toBe("*/*");
    expect(post.redirect).toBe("error");
    expect(result).toEqual({
      status: "completed",
      model: "voice-one",
      voice: "Olivia",
      urls: [`${CDN}/speech.mp3`],
      note: "These links are signed and expire. Download any file you want to keep.",
    });
  });

  it("waits for a speech job and returns its link", async () => {
    vi.useFakeTimers();
    const { fetchFn } = createFetch([
      catalogRoute(),
      ["POST", SPEECH, json({ job_id: "sp-1", status: "queued" }, 202)],
      [
        "GET",
        `${API}/jobs/sp-1`,
        sequence(
          () => json({ status: "processing" }),
          () => json({ status: "completed", result: { audio_url: `${CDN}/long.wav` } }),
        ),
      ],
    ]);
    const result = await settle(run(textToSpeech({ apiKey: TEST_KEY, fetch: fetchFn }), { text: "Hello" }));
    expect(result).toMatchObject({ status: "completed", jobId: "sp-1", urls: [`${CDN}/long.wav`] });
  });

  it("returns raw audio bytes as base64 for the application, and only their size to the model", async () => {
    const { fetchFn } = createFetch([catalogRoute(), ["POST", SPEECH, () => bytes(MP3, "audio/mpeg")]]);
    const tool = textToSpeech({ apiKey: TEST_KEY, fetch: fetchFn });
    const result = await run(tool, { text: "Hello" });
    const base64 = Buffer.from(MP3).toString("base64");
    expect(result).toEqual({
      status: "completed",
      model: "voice-one",
      urls: [],
      inline: [{ base64, mediaType: "audio/mpeg" }],
      note: "The file data was returned directly to the application, so there is no link to download.",
    });
    const forModel = await tool.toModelOutput!({ toolCallId: "1", input: { text: "Hello" }, output: result });
    expect(JSON.stringify(forModel)).not.toContain(base64);
    expect(forModel).toMatchObject({ value: { inline: [{ mediaType: "audio/mpeg", bytes: MP3.byteLength }] } });
  });

  it("names the audio type from the requested format when the bytes come untyped", async () => {
    const { fetchFn, calls } = createFetch([
      catalogRoute(),
      ["POST", SPEECH, () => bytes(MP3, "application/octet-stream")],
    ]);
    const result = await run(textToSpeech({ apiKey: TEST_KEY, fetch: fetchFn }), {
      text: "Hello",
      model: "voice-raw",
      format: "WAV",
    });
    expect(calls.find((call) => call.method === "POST")!.body).toEqual({
      model: "voice-raw",
      input: "Hello",
      response_format: "wav",
    });
    expect(result).toMatchObject({ inline: [{ mediaType: "audio/wav" }] });
  });

  it("sends a format the catalog does not list as output_format, as given", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, json({ error: "not here" }, 404)],
      ["POST", SPEECH, json({ url: `${CDN}/a.flac` })],
    ]);
    const result = await run(textToSpeech({ apiKey: TEST_KEY, fetch: fetchFn }), {
      text: "Hello",
      model: "custom-voice",
      format: "flac",
    });
    expect(calls.find((call) => call.method === "POST")!.body).toEqual({
      model: "custom-voice",
      input: "Hello",
      output_format: "flac",
    });
    expect(result).toMatchObject({ status: "completed", urls: [`${CDN}/a.flac`] });
  });

  it("refuses text longer than the model accepts, before any billed request", async () => {
    const { fetchFn, calls } = createFetch([catalogRoute()]);
    const error = await rejection(
      run(textToSpeech({ apiKey: TEST_KEY, fetch: fetchFn }), { text: "x".repeat(41), model: "voice-one" }),
    );
    expect(error.code).toBe("input_too_long");
    expect(error.message).toContain("voice-one accepts up to 40 characters per request and this text has 41.");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reports an answer that holds no audio", async () => {
    const { fetchFn } = createFetch([catalogRoute(), ["POST", SPEECH, json({ ok: true })]]);
    const error = await rejection(run(textToSpeech({ apiKey: TEST_KEY, fetch: fetchFn }), { text: "Hello" }));
    expect(error.code).toBe("no_output");
  });
});
