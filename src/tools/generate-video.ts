import { tool } from "ai";
import { z } from "zod/v4";
import { MODEL_TASKS } from "../catalog.js";
import { EmpirioLabsError } from "../errors.js";
import { waitForJob } from "../jobs.js";
import { jobIdOf, mediaItems } from "../media.js";
import {
  type CompletedMediaResult,
  type EmpirioLabsTool,
  type EmpirioLabsToolOptions,
  type ProcessingResult,
  completedMedia,
  createClient,
  defaultModelSentence,
  describeWait,
  forModel,
  processing,
  resolveModel,
  waitTimeout,
} from "../shared.js";
import { httpsUrl, modelIdSchema } from "../schemas.js";

export type GenerateVideoInput = {
  prompt?: string | undefined;
  model?: string | undefined;
  imageUrl?: string | undefined;
  durationSeconds?: number | undefined;
  resolution?: string | undefined;
  aspectRatio?: string | undefined;
  generateAudio?: boolean | undefined;
};

export type GenerateVideoResult = CompletedMediaResult | ProcessingResult;

/**
 * A tool that generates a video from a prompt, or animates a still image, with
 * `POST /v1/videos/generations`, then waits for the job.
 */
export function generateVideo(options: EmpirioLabsToolOptions = {}): EmpirioLabsTool<GenerateVideoInput, GenerateVideoResult> {
  const client = createClient(options);
  const timeoutMs = waitTimeout(options);
  return tool({
    description:
      "Generate a video with EmpirioLabs AI from a text prompt, or animate a still image passed as imageUrl. " +
      `Videos usually take 1 to 15 minutes. This tool waits up to ${describeWait(timeoutMs)}; if the video is not ready ` +
      "by then, the result has status processing and a jobId: call checkGenerationJob with that jobId later instead " +
      "of starting a new video. The result links are signed and expire, so download the video to keep it. " +
      "Video is billed to the user's EmpirioLabs AI account per clip or per second of output at the model's listed " +
      "price, so check prices with findModels, which is free, before long or high-resolution videos. " +
      defaultModelSentence(options.model, "video"),
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe("Description of the video. With imageUrl, describes the motion. Required unless imageUrl is given."),
      model: modelIdSchema
        .optional()
        .describe('Model ID from findModels with task "video". Omit to use the default.'),
      imageUrl: httpsUrl.optional().describe("Public https URL of a start image to animate (image to video)."),
      durationSeconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Length in seconds. Supported values depend on the model."),
      resolution: z.string().min(1).optional().describe("Output resolution such as 480p, 720p or 1080p."),
      aspectRatio: z.string().min(1).optional().describe("Aspect ratio such as 16:9, 9:16 or 1:1."),
      generateAudio: z
        .boolean()
        .optional()
        .describe("Set true to also generate an audio track, or false for a silent clip, on models that support it."),
    }),
    execute: async (input, { abortSignal }): Promise<GenerateVideoResult> => {
      if (!input.prompt && !input.imageUrl) {
        throw new EmpirioLabsError("Pass a prompt, an imageUrl, or both.", { code: "invalid_input" });
      }
      client.requireApiKey();
      const { id: model } = await resolveModel(client, input.model, options.model, MODEL_TASKS.video, abortSignal);
      const body: Record<string, unknown> = { model };
      if (input.prompt) {
        body.prompt = input.prompt;
      }
      if (input.imageUrl) {
        body.image = input.imageUrl;
      }
      if (input.durationSeconds !== undefined) {
        body.duration = input.durationSeconds;
      }
      if (input.resolution) {
        body.resolution = input.resolution;
      }
      if (input.aspectRatio) {
        body.aspect_ratio = input.aspectRatio;
      }
      if (input.generateAudio !== undefined) {
        body.generate_audio = input.generateAudio;
      }
      const payload = await client.postJson<unknown>("/videos/generations", body, {
        signal: abortSignal,
        timeoutMs: 120_000,
      });
      const ready = mediaItems(payload);
      if (ready.length > 0) {
        return completedMedia(model, ready, jobIdOf(payload));
      }
      const jobId = jobIdOf(payload);
      if (!jobId) {
        throw new EmpirioLabsError("EmpirioLabs AI did not return a job ID for this video request.", {
          code: "invalid_response",
        });
      }
      const outcome = await waitForJob(client, jobId, { timeoutMs, signal: abortSignal, label: "Video job" });
      if (outcome.state === "processing") {
        return processing(model, jobId, "video");
      }
      const items = mediaItems(outcome.job);
      if (items.length === 0) {
        throw new EmpirioLabsError(`Video job ${jobId} finished without returning a video.`, {
          code: "no_output",
          jobId,
        });
      }
      return completedMedia(model, items, jobId);
    },
    toModelOutput: ({ output }) => forModel(output),
  });
}
