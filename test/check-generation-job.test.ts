import { describe, expect, it } from "vitest";
import { checkGenerationJob } from "../src/index.js";
import { API, CDN, TEST_KEY, createFetch, json, rejection, run } from "./helpers.js";

type Schema = { safeParse(value: unknown): { success: boolean } };

function toolWith(job: unknown, status = 200) {
  const { fetchFn, calls } = createFetch([["GET", /\/jobs\//u, () => json(job, status)]]);
  return { tool: checkGenerationJob({ apiKey: TEST_KEY, fetch: fetchFn }), calls };
}

describe("checkGenerationJob", () => {
  it("returns the output links of a completed job", async () => {
    const { tool, calls } = toolWith({
      job_id: "8b0f3c1e-1d2a-4c55-9a43-5f8a9e2b7c10",
      status: "completed",
      model: "video-turbo",
      result: { data: [{ url: `${CDN}/clip.mp4` }] },
    });
    const result = await run(tool, { jobId: "8b0f3c1e-1d2a-4c55-9a43-5f8a9e2b7c10" });
    expect(calls[0]!.url).toBe(`${API}/jobs/8b0f3c1e-1d2a-4c55-9a43-5f8a9e2b7c10`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(calls[0]!.redirect).toBe("error");
    expect(result).toEqual({
      jobId: "8b0f3c1e-1d2a-4c55-9a43-5f8a9e2b7c10",
      status: "completed",
      model: "video-turbo",
      urls: [`${CDN}/clip.mp4`],
      note: "These links are signed and expire. Download any file you want to keep.",
    });
  });

  it("returns the transcript of a completed transcription job", async () => {
    const { tool } = toolWith({ job_id: "t1", status: "completed", result: { text: "Hello there.", language: "en" } });
    expect(await run(tool, { jobId: "t1" })).toEqual({
      jobId: "t1",
      status: "completed",
      urls: [],
      text: "Hello there.",
      note: "The job is complete.",
    });
  });

  it("returns the raw result of a completed job with no files or text", async () => {
    const { tool } = toolWith({ job_id: "j1", status: "succeeded", result: { score: 0.93 } });
    expect(await run(tool, { jobId: "j1" })).toMatchObject({ status: "completed", urls: [], result: { score: 0.93 } });
  });

  it("reports a running job as processing, including statuses it does not know", async () => {
    for (const status of ["queued", "processing", "running", "uploading"]) {
      const { tool } = toolWith({ job_id: "j2", status, model: "video-turbo" });
      const result = await run(tool, { jobId: "j2" });
      expect(result).toEqual({
        jobId: "j2",
        status: "processing",
        model: "video-turbo",
        message:
          "The job is still running. Check it again later; sending the request again would start and bill a new job.",
      });
    }
  });

  it("returns the error message of a failed job", async () => {
    const { tool } = toolWith({
      job_id: "j3",
      status: "failed",
      error: { error: { message: "The image could not be downloaded.", code: "bad_input" } },
    });
    expect(await run(tool, { jobId: "j3" })).toEqual({
      jobId: "j3",
      status: "failed",
      error: "The job failed: The image could not be downloaded.",
    });
    const cancelled = toolWith({ job_id: "j4", status: "cancelled" });
    expect(await run(cancelled.tool, { jobId: "j4" })).toMatchObject({
      status: "failed",
      error: "The job ended with status cancelled: no details were returned",
    });
  });

  it("throws the API's error for an unknown job", async () => {
    const { tool } = toolWith({ error: { message: "Job 'x1' not found", code: "not_found" } }, 404);
    const error = await rejection(run(tool, { jobId: "x1" }));
    expect(error.status).toBe(404);
    expect(error.message).toBe(
      "EmpirioLabs AI API error (HTTP 404): Job 'x1' not found. Check the model ID or job ID. findModels lists the " +
        "available models.",
    );
  });

  it("encodes the job ID into one path segment", async () => {
    const { tool, calls } = toolWith({ status: "processing" });
    await run(tool, { jobId: "job_01HV3K:a.b" });
    expect(calls[0]!.url).toBe(`${API}/jobs/job_01HV3K%3Aa.b`);
  });

  it("refuses anything that is not a job ID, without a request", async () => {
    const { tool, calls } = toolWith({ status: "processing" });
    const schema = tool.inputSchema as unknown as Schema;
    for (const jobId of ["", "..", "../models", "a/b", "https://evil.example/x", "id?x=1", "a b"]) {
      expect(schema.safeParse({ jobId }).success).toBe(false);
      const error = await rejection(run(tool, { jobId }));
      expect(error.code).toBe("invalid_job_id");
    }
    expect(calls).toHaveLength(0);
  });
});
