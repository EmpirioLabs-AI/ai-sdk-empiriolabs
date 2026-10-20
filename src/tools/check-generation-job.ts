import { tool } from "ai";
import { z } from "zod/v4";
import { JOB_ID_PATTERN, fetchJob, jobError, jobState, jobStatus } from "../jobs.js";
import { mediaItems, transcriptText } from "../media.js";
import {
  type EmpirioLabsClientOptions,
  type EmpirioLabsTool,
  type InlineFile,
  createClient,
  forModel,
  splitMedia,
} from "../shared.js";

export type CheckGenerationJobInput = {
  jobId: string;
};

export type CheckGenerationJobResult =
  | {
      jobId: string;
      status: "completed";
      model?: string;
      urls: string[];
      inline?: InlineFile[];
      text?: string;
      /** The job's raw result, included only when it holds neither files nor text. */
      result?: unknown;
      note: string;
    }
  | { jobId: string; status: "processing"; model?: string; message: string }
  | { jobId: string; status: "failed"; model?: string; error: string };

/** A tool that reads a generation job with `GET /v1/jobs/{job_id}` and returns its status and output. */
export function checkGenerationJob(
  options: EmpirioLabsClientOptions = {},
): EmpirioLabsTool<CheckGenerationJobInput, CheckGenerationJobResult> {
  const client = createClient(options);
  return tool({
    description:
      "Check an EmpirioLabs AI generation job by the jobId that generateVideo, generateImage, textToSpeech or " +
      "transcribeAudio returned with status processing. Returns status processing, completed or failed. A completed " +
      "job includes links to the output, which are signed and expire, so download anything you want to keep, or the " +
      "transcript text; a failed job includes the error message. A processing job is still running: check it again " +
      "later instead of starting a new generation, which would be billed again.",
    inputSchema: z.object({
      jobId: z
        .string()
        .trim()
        .regex(JOB_ID_PATTERN, "Pass the jobId exactly as a generation tool returned it.")
        .describe("The jobId returned by a generation tool."),
    }),
    execute: async (input, { abortSignal }): Promise<CheckGenerationJobResult> => {
      client.requireApiKey();
      const jobId = input.jobId.trim();
      const job = await fetchJob(client, jobId, abortSignal);
      const status = jobStatus(job);
      const state = jobState(status);
      const model = typeof job.model === "string" && job.model ? { model: job.model } : {};
      if (state === "failed") {
        const { message } = jobError(job);
        const outcome = status === "failed" ? "The job failed" : `The job ended with status ${status}`;
        return {
          jobId,
          status: "failed",
          ...model,
          error: client.redact(`${outcome}: ${message ?? "no details were returned"}`),
        };
      }
      if (state === "processing") {
        return {
          jobId,
          status: "processing",
          ...model,
          message: "The job is still running. Check it again later; sending the request again would start and bill a new job.",
        };
      }
      const items = mediaItems(job);
      const result = "result" in job ? job.result : job;
      const text = transcriptText(result);
      const media = splitMedia(items);
      return {
        jobId,
        status: "completed",
        ...model,
        urls: media.urls,
        ...(media.inline ? { inline: media.inline } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(items.length === 0 && text === undefined ? { result } : {}),
        note: items.length > 0 ? media.note : "The job is complete.",
      };
    },
    toModelOutput: ({ output }) => forModel(output),
  });
}
