import { tool } from "ai";
import { z } from "zod/v4";
import {
  MODEL_TASKS,
  MODEL_TASK_NAMES,
  type ModelTask,
  candidates,
  loadCatalog,
  matchesQuery,
  pickDefault,
  priceSummary,
  stringList,
} from "../catalog.js";
import { PRICING_URL } from "../constants.js";
import { type EmpirioLabsClientOptions, type EmpirioLabsTool, createClient } from "../shared.js";

export type FindModelsInput = {
  task: ModelTask;
  query?: string | undefined;
  limit?: number | undefined;
};

export type FoundModel = {
  id: string;
  name: string;
  /** Short summary of the model's listed prices. */
  price: string;
  endpoints: string[];
  /** True for the model the other tools use when no model is given. */
  isDefault: boolean;
};

export type FindModelsResult = {
  task: ModelTask;
  /** Number of matching models, before `limit`. */
  total: number;
  models: FoundModel[];
};

const DEFAULT_LIMIT = 20;

/**
 * A tool that lists models for a task from the public catalog (`GET /v1/models`),
 * with prices. It never sends the API key and costs nothing.
 */
export function findModels(options: EmpirioLabsClientOptions = {}): EmpirioLabsTool<FindModelsInput, FindModelsResult> {
  const client = createClient({
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  return tool({
    description:
      "Find EmpirioLabs AI models for a task in the live public catalog, with their prices. Free: nothing is billed. " +
      "Returns model IDs to pass as model to the other EmpirioLabs AI tools, display names, a short summary of each " +
      "model's listed prices, and the API endpoints each model serves. The model marked isDefault is the one the other " +
      `tools use when model is omitted. Full pricing: ${PRICING_URL}`,
    inputSchema: z.object({
      task: z
        .enum(MODEL_TASK_NAMES)
        .describe(
          "What the model is for: chat, image (text to image), image-edit (image models that accept input images), " +
            "video, speech (text to speech), transcription (speech to text), or embedding.",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Words that must all appear in the model ID, name, description, author or features, for example flux or qwen.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(`Maximum number of models to return, 1 to 100. Defaults to ${DEFAULT_LIMIT}.`),
    }),
    execute: async (input, { abortSignal }): Promise<FindModelsResult> => {
      const spec = MODEL_TASKS[input.task];
      const pool = candidates(await loadCatalog(client, abortSignal), spec);
      const defaultId = pool.length > 0 ? pickDefault(pool, spec).id : undefined;
      const words = (input.query ?? "")
        .toLowerCase()
        .split(/\s+/u)
        .filter((word) => word.length > 0);
      const matched = words.length > 0 ? pool.filter((model) => matchesQuery(model, words)) : pool;
      return {
        task: input.task,
        total: matched.length,
        models: matched.slice(0, input.limit ?? DEFAULT_LIMIT).map((model) => ({
          id: model.id,
          name: typeof model.display_name === "string" && model.display_name ? model.display_name : model.id,
          price: priceSummary(model),
          endpoints: stringList(model.supported_endpoints),
          isDefault: model.id === defaultId,
        })),
      };
    },
  });
}
