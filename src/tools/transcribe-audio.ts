import { tool } from "ai";
import { z } from "zod/v4";
import { MODEL_TASKS } from "../catalog.js";
import { EmpirioLabsError } from "../errors.js";
import { isRecord } from "../http.js";
import { waitForJob } from "../jobs.js";
import { jobIdOf, transcriptText } from "../media.js";
import {
  type EmpirioLabsTool,
  type EmpirioLabsToolOptions,
  type ProcessingResult,
  createClient,
  defaultModelSentence,
  describeWait,
  forModel,
  processing,
  resolveModel,
  waitTimeout,
} from "../shared.js";
import { httpsUrl, modelIdSchema } from "../schemas.js";

export type TranscribeAudioInput = {
  audioUrl: string;
  model?: string | undefined;
  language?: string | undefined;
};

export type TranscribeAudioResult =
  | {
      status: "completed";
      model: string;
      jobId?: string;
      text: string;
      language?: string;
      durationSeconds?: number;
    }
  | {
      status: "completed";
      model: string;
      jobId?: string;
      text: null;
      /** The full result, returned when it holds no plain-text transcript. */
      result: unknown;
    }
  | ProcessingResult;

function details(result: unknown): { language?: string; durationSeconds?: number } {
  if (!isRecord(result)) {
    return {};
  }
  return {
    ...(typeof result.language === "string" && result.language ? { language: result.language } : {}),
    ...(typeof result.duration === "number" && Number.isFinite(result.duration)
      ? { durationSeconds: result.duration }
      : {}),
  };
}

function finished(model: string, result: unknown, jobId: string | undefined): TranscribeAudioResult {
  const text = transcriptText(result);
  const job = jobId ? { jobId } : {};
  if (text === undefined) {
    return { status: "completed", model, ...job, text: null, result };
  }
  return { status: "completed", model, ...job, text, ...details(result) };
}

/** A tool that transcribes an audio or video file at an https URL with `POST /v1/audio/transcriptions`. */
export function transcribeAudio(
  options: EmpirioLabsToolOptions = {},
): EmpirioLabsTool<TranscribeAudioInput, TranscribeAudioResult> {
  const client = createClient(options);
  const timeoutMs = waitTimeout(options);
  return tool({
    description:
      "Transcribe the speech in an audio or video file at a public https URL with EmpirioLabs AI and return the text. " +
      `Long recordings can take several minutes; if the transcript is not ready within ${describeWait(timeoutMs)}, the ` +
      "result has status processing and a jobId for checkGenerationJob. Billed to the user's EmpirioLabs AI account " +
      "by audio length at the model's listed price; compare transcription models with findModels, which is free. " +
      defaultModelSentence(options.model, "transcription"),
    inputSchema: z.object({
      audioUrl: httpsUrl.describe("Public https URL of the audio or video file to transcribe."),
      model: modelIdSchema
        .optional()
        .describe('Model ID from findModels with task "transcription". Omit to use the default.'),
      language: z
        .string()
        .min(1)
        .optional()
        .describe("Spoken language hint such as en, on models that accept it. Omit to detect it."),
    }),
    execute: async (input, { abortSignal }): Promise<TranscribeAudioResult> => {
      client.requireApiKey();
      const { id: model } = await resolveModel(
        client,
        input.model,
        options.model,
        MODEL_TASKS.transcription,
        abortSignal,
      );
      const body: Record<string, unknown> = { model, file_url: input.audioUrl };
      if (input.language) {
        body.language = input.language;
      }
      const payload = await client.postJson<unknown>("/audio/transcriptions", body, {
        signal: abortSignal,
        timeoutMs: 120_000,
      });
      const jobId = jobIdOf(payload);
      if (!jobId) {
        if (transcriptText(payload) !== undefined) {
          return finished(model, payload, undefined);
        }
        throw new EmpirioLabsError("EmpirioLabs AI did not return a job ID for this transcription.", {
          code: "invalid_response",
        });
      }
      const outcome = await waitForJob(client, jobId, {
        timeoutMs,
        signal: abortSignal,
        label: "Transcription job",
      });
      if (outcome.state === "processing") {
        return processing(model, jobId, "transcript");
      }
      const result = "result" in outcome.job ? outcome.job.result : outcome.job;
      return finished(model, result, jobId);
    },
    toModelOutput: ({ output }) => forModel(output),
  });
}
