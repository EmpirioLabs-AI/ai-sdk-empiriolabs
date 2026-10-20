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
  forModel,
  processing,
  resolveModel,
  waitTimeout,
} from "../shared.js";
import { httpsUrl, modelIdSchema } from "../schemas.js";

export type GenerateImageInput = {
  prompt: string;
  model?: string | undefined;
  aspectRatio?: string | undefined;
  size?: string | undefined;
  numberOfImages?: number | undefined;
  referenceImageUrls?: string[] | undefined;
};

export type GenerateImageResult = CompletedMediaResult | ProcessingResult;

/** The API holds an image request open while it renders, so the request itself may take minutes. */
const IMAGE_REQUEST_TIMEOUT_MS = 330_000;

/**
 * A tool that generates images from a prompt, or edits images passed as
 * `referenceImageUrls`, with `POST /v1/images/generations`.
 */
export function generateImage(options: EmpirioLabsToolOptions = {}): EmpirioLabsTool<GenerateImageInput, GenerateImageResult> {
  const client = createClient(options);
  const timeoutMs = waitTimeout(options);
  return tool({
    description:
      "Generate images from a text prompt with EmpirioLabs AI, or edit images by passing referenceImageUrls. " +
      "Returns links to the finished images. The links are signed and expire, so download any image you want to keep. " +
      "Each image is billed to the user's EmpirioLabs AI account at the model's listed price; compare image models " +
      "and prices with findModels, which is free. " +
      defaultModelSentence(options.model, "image") +
      " If an image is not ready when the tool stops waiting, the result has status processing and a jobId for " +
      "checkGenerationJob.",
    inputSchema: z.object({
      prompt: z.string().min(1).describe("What to create, or the change to make when referenceImageUrls are given."),
      model: modelIdSchema
        .optional()
        .describe('Model ID from findModels (task "image", or "image-edit" when editing). Omit to use the default.'),
      aspectRatio: z
        .string()
        .min(1)
        .optional()
        .describe("Aspect ratio such as 1:1, 16:9 or 9:16, on models that accept it."),
      size: z.string().min(1).optional().describe("Output size such as 1024x1024, on models that accept it."),
      numberOfImages: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe("How many images to create, 1 to 4. Each image is billed."),
      referenceImageUrls: z
        .array(httpsUrl)
        .min(1)
        .optional()
        .describe(
          'Public https URLs of images to edit or use as references. Use a model from findModels with task "image-edit".',
        ),
    }),
    execute: async (input, { abortSignal }): Promise<GenerateImageResult> => {
      client.requireApiKey();
      const references = input.referenceImageUrls ?? [];
      const editing = references.length > 0;
      const { id: model } = await resolveModel(
        client,
        input.model,
        options.model,
        editing ? MODEL_TASKS["image-edit"] : MODEL_TASKS.image,
        abortSignal,
      );
      const body: Record<string, unknown> = {
        model,
        prompt: input.prompt,
        sync: true,
        response_format: "url",
      };
      if (input.aspectRatio) {
        body.aspect_ratio = input.aspectRatio;
      }
      if (input.size) {
        body.size = input.size;
      }
      if (input.numberOfImages !== undefined) {
        body.num_images = input.numberOfImages;
      }
      if (editing) {
        body.image = references;
      }
      const payload = await client.postJson<unknown>("/images/generations", body, {
        signal: abortSignal,
        timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
      });
      let items = mediaItems(payload);
      const jobId = jobIdOf(payload);
      if (items.length === 0 && jobId) {
        const outcome = await waitForJob(client, jobId, { timeoutMs, signal: abortSignal, label: "Image job" });
        if (outcome.state === "processing") {
          return processing(model, jobId, "image");
        }
        items = mediaItems(outcome.job);
      }
      if (items.length === 0) {
        throw new EmpirioLabsError(
          "The request finished without returning an image. Adjust the prompt and try again.",
          { code: "no_output", ...(jobId ? { jobId } : {}) },
        );
      }
      return completedMedia(model, items, jobId);
    },
    toModelOutput: ({ output }) => forModel(output),
  });
}
