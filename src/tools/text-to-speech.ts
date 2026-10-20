import { tool } from "ai";
import { z } from "zod/v4";
import { MODEL_TASKS, matchOption, parameterSpec } from "../catalog.js";
import { EmpirioLabsError } from "../errors.js";
import { toBase64 } from "../http.js";
import { waitForJob } from "../jobs.js";
import { jobIdOf, mediaItems } from "../media.js";
import {
  INLINE_DATA_NOTE,
  type EmpirioLabsTool,
  type EmpirioLabsToolOptions,
  type InlineFile,
  type ProcessingResult,
  catalogEntry,
  completedMedia,
  createClient,
  defaultModelSentence,
  forModel,
  processing,
  resolveModel,
  waitTimeout,
} from "../shared.js";
import { modelIdSchema } from "../schemas.js";

export type TextToSpeechInput = {
  text: string;
  model?: string | undefined;
  voice?: string | undefined;
  format?: string | undefined;
};

export type TextToSpeechResult =
  | {
      status: "completed";
      model: string;
      voice?: string;
      jobId?: string;
      /** Signed, expiring links to the audio. Empty when the model returned the audio data directly. */
      urls: string[];
      /** Audio data from models that return the bytes directly. */
      inline?: InlineFile[];
      note: string;
    }
  | ProcessingResult;

const SPEECH_REQUEST_TIMEOUT_MS = 300_000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const FORMAT_PARAMETERS = ["output_format", "format", "response_format"] as const;
const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  aac: "audio/aac",
  pcm: "audio/pcm",
};

function isAudioBytes(contentType: string): boolean {
  return (
    contentType.startsWith("audio/") ||
    contentType === "application/octet-stream" ||
    contentType === "binary/octet-stream"
  );
}

/** A tool that turns text into speech with `POST /v1/audio/speech`. */
export function textToSpeech(options: EmpirioLabsToolOptions = {}): EmpirioLabsTool<TextToSpeechInput, TextToSpeechResult> {
  const client = createClient(options);
  const timeoutMs = waitTimeout(options);
  return tool({
    description:
      "Turn text into speech with EmpirioLabs AI. Returns a link to the audio file, which is signed and expires, so " +
      "download it to keep it. A few models return the audio data directly; that data goes to the application, and " +
      "the result says so. Billed to the user's EmpirioLabs AI account by characters or tokens at the model's listed " +
      "price; compare speech models with findModels, which is free. " +
      defaultModelSentence(options.model, "text-to-speech"),
    inputSchema: z.object({
      text: z.string().min(1).describe("The text to speak."),
      model: modelIdSchema
        .optional()
        .describe('Model ID from findModels with task "speech". Omit to use the default.'),
      voice: z
        .string()
        .min(1)
        .optional()
        .describe("Voice name or ID for the chosen model. Omit for the model's default voice."),
      format: z.string().min(1).optional().describe("Audio format such as mp3 or wav, on models that accept it."),
    }),
    execute: async (input, { abortSignal }): Promise<TextToSpeechResult> => {
      client.requireApiKey();
      const resolved = await resolveModel(client, input.model, options.model, MODEL_TASKS.speech, abortSignal);
      const model = resolved.id;
      const entry = resolved.entry ?? (await catalogEntry(client, model, abortSignal));
      const limit = parameterSpec(entry, "input")?.max;
      if (typeof limit === "number" && input.text.length > limit) {
        throw new EmpirioLabsError(
          `${model} accepts up to ${limit} characters per request and this text has ${input.text.length}. ` +
            "Split the text into parts, or choose another model with findModels.",
          { code: "input_too_long" },
        );
      }
      const body: Record<string, unknown> = { model, input: input.text };
      if (input.voice) {
        body.voice = input.voice;
      }
      if (input.format) {
        const match = FORMAT_PARAMETERS.map((name) => [name, matchOption(entry, name, input.format!)] as const).find(
          ([, option]) => option !== undefined,
        );
        if (match) {
          body[match[0]] = match[1];
        } else {
          body.output_format = input.format;
        }
      }
      const response = await client.post("/audio/speech", body, {
        signal: abortSignal,
        timeoutMs: SPEECH_REQUEST_TIMEOUT_MS,
        maxBytes: MAX_AUDIO_BYTES,
      });
      const voice = input.voice ? { voice: input.voice } : {};
      if (isAudioBytes(response.contentType)) {
        if (response.body.byteLength === 0) {
          throw new EmpirioLabsError("The request finished without returning audio.", { code: "no_output" });
        }
        const mediaType = response.contentType.startsWith("audio/")
          ? response.contentType
          : (AUDIO_TYPES[(input.format ?? "").toLowerCase()] ?? "application/octet-stream");
        return {
          status: "completed",
          model,
          ...voice,
          urls: [],
          inline: [{ base64: toBase64(response.body), mediaType }],
          note: INLINE_DATA_NOTE,
        };
      }
      const payload = client.parseJson<unknown>(response);
      let items = mediaItems(payload);
      const jobId = jobIdOf(payload);
      if (items.length === 0 && jobId) {
        const outcome = await waitForJob(client, jobId, { timeoutMs, signal: abortSignal, label: "Speech job" });
        if (outcome.state === "processing") {
          return processing(model, jobId, "audio");
        }
        items = mediaItems(outcome.job);
      }
      if (items.length === 0) {
        throw new EmpirioLabsError("The request finished without returning audio.", {
          code: "no_output",
          ...(jobId ? { jobId } : {}),
        });
      }
      return { ...completedMedia(model, items, jobId), ...voice };
    },
    toModelOutput: ({ output }) => forModel(output),
  });
}
