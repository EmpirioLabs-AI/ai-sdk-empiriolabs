import { describe, expect, it, vi } from "vitest";
import { generateVideo } from "../src/index.js";
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

const VIDEOS = `${API}/videos/generations`;
const accepted = (id: string) => () => json({ job_id: id, status: "processing", poll_url: `/v1/jobs/${id}` });
const running = (id: string) => () => json({ job_id: id, status: "processing" });
const completed = (id: string) => () =>
  json({ job_id: id, status: "completed", model: "video-turbo", result: { data: [{ url: `${CDN}/clip.mp4` }] } });

const gaps = (times: number[]) => times.slice(1).map((time, index) => time - times[index]!);

describe("generateVideo", () => {
  it("submits the documented request, then polls the job until it finishes", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      catalogRoute(),
      ["POST", VIDEOS, accepted("vid-1")],
      ["GET", `${API}/jobs/vid-1`, sequence(running("vid-1"), running("vid-1"), running("vid-1"), completed("vid-1"))],
    ]);
    const result = await settle(
      run(generateVideo({ apiKey: TEST_KEY, fetch: fetchFn }), {
        prompt: "the camera slowly pushes in",
        imageUrl: "https://images.example.com/still.png",
        durationSeconds: 5,
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: false,
      }),
    );
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({
      model: "video-turbo",
      prompt: "the camera slowly pushes in",
      image: "https://images.example.com/still.png",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
      generate_audio: false,
    });
    expect(post.redirect).toBe("error");
    const polls = calls.filter((call) => call.url === `${API}/jobs/vid-1`);
    expect(polls.every((call) => call.headers.get("authorization") === `Bearer ${TEST_KEY}`)).toBe(true);
    expect(gaps(polls.map((call) => call.at))).toEqual([2000, 3000, 4500]);
    expect(result).toEqual({
      status: "completed",
      model: "video-turbo",
      jobId: "vid-1",
      urls: [`${CDN}/clip.mp4`],
      note: "These links are signed and expire. Download any file you want to keep.",
    });
  });

  it("backs off from 2 s to at most 10 s, then returns the job ID when the wait runs out", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      ["POST", VIDEOS, accepted("vid-2")],
      ["GET", `${API}/jobs/vid-2`, running("vid-2")],
    ]);
    const tool = generateVideo({ apiKey: TEST_KEY, fetch: fetchFn, model: "video-turbo", waitTimeoutMs: 60_000 });
    expect(tool.description).toContain("This tool waits up to 1 minute;");
    const result = await settle(run(tool, { prompt: "waves at sunset" }));
    const times = calls.filter((call) => call.method === "GET").map((call) => call.at);
    // Checks at 0, 2, 5, 9.5, 16.25, 26.25, 36.25, 46.25 and 56.25 s; one more 10 s wait would pass 60 s.
    expect(gaps(times)).toEqual([2000, 3000, 4500, 6750, 10000, 10000, 10000, 10000]);
    expect(times[times.length - 1]! - times[0]!).toBeLessThanOrEqual(60_000);
    expect(result).toMatchObject({ status: "processing", jobId: "vid-2", model: "video-turbo" });
    expect((result as { message: string }).message).toContain("Call checkGenerationJob with this jobId");
  });

  it("waits five minutes by default", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      ["POST", VIDEOS, accepted("vid-3")],
      ["GET", `${API}/jobs/vid-3`, running("vid-3")],
    ]);
    const tool = generateVideo({ apiKey: TEST_KEY, fetch: fetchFn, model: "video-turbo" });
    expect(tool.description).toContain("This tool waits up to 5 minutes;");
    const started = Date.now();
    const result = await settle(run(tool, { prompt: "x" }), 1000);
    const last = calls[calls.length - 1]!.at - started;
    expect(result).toMatchObject({ status: "processing", jobId: "vid-3" });
    expect(last).toBeGreaterThan(290_000);
    expect(last).toBeLessThanOrEqual(300_000);
  });

  it("returns at once when the response already holds the video", async () => {
    const { fetchFn, calls } = createFetch([["POST", VIDEOS, json({ data: [{ url: `${CDN}/fast.mp4` }] })]]);
    const result = await run(generateVideo({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x" });
    expect(result).toMatchObject({ status: "completed", urls: [`${CDN}/fast.mp4`] });
    expect(calls).toHaveLength(1);
  });

  it("needs a prompt or an image, and sends nothing without one", async () => {
    const { fetchFn, calls } = createFetch([]);
    const error = await rejection(run(generateVideo({ apiKey: TEST_KEY, fetch: fetchFn }), {}));
    expect(error.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("reports a response without a job ID", async () => {
    const { fetchFn } = createFetch([["POST", VIDEOS, json({ status: "processing" })]]);
    const error = await rejection(run(generateVideo({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x" }));
    expect(error.code).toBe("invalid_response");
  });

  it("throws the job's error when the video fails", async () => {
    const { fetchFn } = createFetch([
      ["POST", VIDEOS, accepted("vid-4")],
      ["GET", `${API}/jobs/vid-4`, json({ status: "cancelled", error: "The job was cancelled." })],
    ]);
    const error = await rejection(run(generateVideo({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x" }));
    expect(error.message).toBe("Video job vid-4 cancelled: The job was cancelled.");
    expect(error.jobId).toBe("vid-4");
  });

  it("stops polling as soon as the caller aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { fetchFn, calls } = createFetch([
      ["POST", VIDEOS, accepted("vid-5")],
      ["GET", `${API}/jobs/vid-5`, running("vid-5")],
    ]);
    const pending = run(generateVideo({ apiKey: TEST_KEY, fetch: fetchFn, model: "m" }), { prompt: "x" }, controller.signal);
    const outcome = rejection(pending);
    await vi.advanceTimersByTimeAsync(2500);
    const polled = calls.length;
    controller.abort();
    const error = await outcome;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error.name).toBe("AbortError");
    expect(calls.length).toBe(polled);
  });
});
