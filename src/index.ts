/**
 * EmpirioLabs AI tools for Vercel AI SDK agents: image and video generation,
 * text to speech, audio transcription, generation jobs, and a model finder.
 */
import type { EmpirioLabsClientOptions, EmpirioLabsTool } from "./shared.js";
import { checkGenerationJob } from "./tools/check-generation-job.js";
import type { CheckGenerationJobInput, CheckGenerationJobResult } from "./tools/check-generation-job.js";
import { findModels } from "./tools/find-models.js";
import type { FindModelsInput, FindModelsResult } from "./tools/find-models.js";
import { generateImage } from "./tools/generate-image.js";
import type { GenerateImageInput, GenerateImageResult } from "./tools/generate-image.js";
import { generateVideo } from "./tools/generate-video.js";
import type { GenerateVideoInput, GenerateVideoResult } from "./tools/generate-video.js";
import { textToSpeech } from "./tools/text-to-speech.js";
import type { TextToSpeechInput, TextToSpeechResult } from "./tools/text-to-speech.js";
import { transcribeAudio } from "./tools/transcribe-audio.js";
import type { TranscribeAudioInput, TranscribeAudioResult } from "./tools/transcribe-audio.js";

export { generateImage, generateVideo, checkGenerationJob, textToSpeech, transcribeAudio, findModels };
export { EmpirioLabsError, type EmpirioLabsErrorDetails } from "./errors.js";
export { DEFAULT_BASE_URL, API_KEY_ENV_VAR, PACKAGE_VERSION } from "./constants.js";
export type { FetchFunction } from "./http.js";
export type { ModelTask } from "./catalog.js";
export type {
  CompletedMediaResult,
  EmpirioLabsClientOptions,
  EmpirioLabsTool,
  EmpirioLabsToolOptions,
  InlineFile,
  ProcessingResult,
} from "./shared.js";
export type {
  CheckGenerationJobInput,
  CheckGenerationJobResult,
  FindModelsInput,
  FindModelsResult,
  GenerateImageInput,
  GenerateImageResult,
  GenerateVideoInput,
  GenerateVideoResult,
  TextToSpeechInput,
  TextToSpeechResult,
  TranscribeAudioInput,
  TranscribeAudioResult,
};
export type { FoundModel } from "./tools/find-models.js";

/** Options for `empiriolabsTools()`. Every field is optional. */
export type EmpirioLabsToolsOptions = EmpirioLabsClientOptions & {
  /** How long a generation tool waits for a queued job, in milliseconds. Defaults to 300000 (5 minutes). */
  waitTimeoutMs?: number;
  /** Default model per tool, used when a tool call does not name one. Otherwise each tool uses the catalog default. */
  models?: {
    image?: string;
    video?: string;
    speech?: string;
    transcription?: string;
  };
};

/** The six EmpirioLabs AI tools, keyed by the names the model sees. */
export type EmpirioLabsTools = {
  generateImage: EmpirioLabsTool<GenerateImageInput, GenerateImageResult>;
  generateVideo: EmpirioLabsTool<GenerateVideoInput, GenerateVideoResult>;
  checkGenerationJob: EmpirioLabsTool<CheckGenerationJobInput, CheckGenerationJobResult>;
  textToSpeech: EmpirioLabsTool<TextToSpeechInput, TextToSpeechResult>;
  transcribeAudio: EmpirioLabsTool<TranscribeAudioInput, TranscribeAudioResult>;
  findModels: EmpirioLabsTool<FindModelsInput, FindModelsResult>;
};

/**
 * Every EmpirioLabs AI tool, ready to pass as `tools` to `generateText`,
 * `streamText`, or an agent.
 *
 * ```ts
 * const { text } = await generateText({ model, tools: empiriolabsTools(), stopWhen: isStepCount(5), prompt });
 * ```
 */
export function empiriolabsTools(options: EmpirioLabsToolsOptions = {}): EmpirioLabsTools {
  const { models, waitTimeoutMs, ...client } = options;
  const generation = { ...client, ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}) };
  const withModel = (model: string | undefined) => ({ ...generation, ...(model ? { model } : {}) });
  return {
    generateImage: generateImage(withModel(models?.image)),
    generateVideo: generateVideo(withModel(models?.video)),
    checkGenerationJob: checkGenerationJob(client),
    textToSpeech: textToSpeech(withModel(models?.speech)),
    transcribeAudio: transcribeAudio(withModel(models?.transcription)),
    findModels: findModels(client),
  };
}
