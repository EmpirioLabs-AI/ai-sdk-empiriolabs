import { describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "../src/index.js";
import { transcriptText } from "../src/media.js";
import { API, TEST_KEY, catalogRoute, createFetch, json, rejection, run, sequence, settle } from "./helpers.js";

const TRANSCRIPTIONS = `${API}/audio/transcriptions`;
const AUDIO = "https://media.example.com/samples/meeting.wav";

type Schema = { safeParse(value: unknown): { success: boolean } };

describe("transcribeAudio", () => {
  it("sends the file URL, waits for the job, and returns the text", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      catalogRoute(),
      ["POST", TRANSCRIPTIONS, json({ job_id: "tr-1", status: "processing", poll_url: "/v1/jobs/tr-1" }, 202)],
      [
        "GET",
        `${API}/jobs/tr-1`,
        sequence(
          () => json({ job_id: "tr-1", status: "processing" }),
          () =>
            json({
              job_id: "tr-1",
              status: "completed",
              result: { text: "Welcome to the weekly update.", language: "en", duration: 3.4, segments: [] },
            }),
        ),
      ],
    ]);
    const result = await settle(
      run(transcribeAudio({ apiKey: TEST_KEY, fetch: fetchFn }), { audioUrl: AUDIO, language: "en" }),
    );
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({ model: "stt-turbo", file_url: AUDIO, language: "en" });
    expect(post.redirect).toBe("error");
    expect(result).toEqual({
      status: "completed",
      model: "stt-turbo",
      jobId: "tr-1",
      text: "Welcome to the weekly update.",
      language: "en",
      durationSeconds: 3.4,
    });
  });

  it("returns the text when the answer already holds it", async () => {
    const { fetchFn } = createFetch([["POST", TRANSCRIPTIONS, json({ text: "Short clip." })]]);
    const result = await run(transcribeAudio({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { audioUrl: AUDIO });
    expect(result).toEqual({ status: "completed", model: "m", text: "Short clip." });
  });

  it("returns the full result when it holds no plain text", async () => {
    const { fetchFn } = createFetch([
      ["POST", TRANSCRIPTIONS, json({ job_id: "tr-2", status: "processing" })],
      ["GET", `${API}/jobs/tr-2`, json({ status: "completed", result: { words: [{ w: "hi" }] } })],
    ]);
    const result = await run(transcribeAudio({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { audioUrl: AUDIO });
    expect(result).toEqual({ status: "completed", model: "m", jobId: "tr-2", text: null, result: { words: [{ w: "hi" }] } });
  });

  it("returns the job ID with status processing when the transcript takes longer than the wait", async () => {
    vi.useFakeTimers();
    const { fetchFn } = createFetch([
      ["POST", TRANSCRIPTIONS, json({ job_id: "tr-3", status: "processing" })],
      ["GET", `${API}/jobs/tr-3`, () => json({ status: "processing" })],
    ]);
    const tool = transcribeAudio({ apiKey: TEST_KEY, fetch: fetchFn, model: "m", waitTimeoutMs: 30_000 });
    expect(tool.description).toContain("not ready within 30 seconds");
    expect(await settle(run(tool, { audioUrl: AUDIO }))).toMatchObject({ status: "processing", jobId: "tr-3" });
  });

  it("reports an answer without a job ID or text", async () => {
    const { fetchFn } = createFetch([["POST", TRANSCRIPTIONS, json({ status: "ok" })]]);
    const error = await rejection(run(transcribeAudio({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { audioUrl: AUDIO }));
    expect(error.code).toBe("invalid_response");
  });

  it("accepts only https URLs", () => {
    const schema = transcribeAudio({ apiKey: TEST_KEY }).inputSchema as unknown as Schema;
    expect(schema.safeParse({ audioUrl: AUDIO }).success).toBe(true);
    for (const audioUrl of ["http://media.example.com/a.wav", "ftp://media.example.com/a.wav", "meeting.wav", ""]) {
      expect(schema.safeParse({ audioUrl }).success).toBe(false);
    }
  });
});

describe("transcript text", () => {
  it("reads text, transcript, or joined segments", () => {
    expect(transcriptText({ text: "a" })).toBe("a");
    expect(transcriptText({ transcript: "b" })).toBe("b");
    expect(transcriptText({ segments: [{ text: " one " }, { text: "two" }, { start: 1 }] })).toBe("one two");
    expect(transcriptText("plain")).toBe("plain");
    expect(transcriptText({ segments: [] })).toBeUndefined();
    expect(transcriptText(null)).toBeUndefined();
  });
});
