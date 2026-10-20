/**
 * The public EmpirioLabs AI model catalog (`GET /v1/models`, no API key), with a
 * short in-memory cache, default-model selection, and price summaries.
 */
import { CATALOG_CACHE_TTL_MS, ENDPOINTS, PRICING_URL } from "./constants.js";
import { EmpirioLabsError, abortReason } from "./errors.js";
import { type ApiClient, isRecord } from "./http.js";

export type CatalogModel = {
  id: string;
  display_name?: unknown;
  category?: unknown;
  status?: unknown;
  is_featured?: unknown;
  native_inference?: unknown;
  supported_endpoints?: unknown;
  features?: unknown;
  pricing_rows?: unknown;
  supported_parameters?: unknown;
  description?: unknown;
  author?: unknown;
  aliases?: unknown;
  api_url?: unknown;
  [key: string]: unknown;
};

/** The tasks `findModels` understands, and how each maps onto the catalog. */
export const MODEL_TASKS = {
  chat: { endpoint: ENDPOINTS.chat, category: "text" },
  image: { endpoint: ENDPOINTS.image, category: "image" },
  "image-edit": { endpoint: ENDPOINTS.image, category: "image", feature: "image_editing" },
  video: { endpoint: ENDPOINTS.video, category: "video" },
  speech: { endpoint: ENDPOINTS.speech, category: "audio" },
  transcription: { endpoint: ENDPOINTS.transcription, category: "transcription" },
  embedding: { endpoint: ENDPOINTS.embedding, category: "embedding" },
} as const satisfies Record<string, TaskSpec>;

export type ModelTask = keyof typeof MODEL_TASKS;
export type TaskSpec = { endpoint: string; category?: string; feature?: string };

export const MODEL_TASK_NAMES = Object.keys(MODEL_TASKS) as [ModelTask, ...ModelTask[]];

type CacheEntry = { models?: CatalogModel[]; expires: number; pending?: Promise<CatalogModel[]> };
const cache = new Map<string, CacheEntry>();

/** Forgets every cached catalog. */
export function clearCatalogCache(): void {
  cache.clear();
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function parseCatalog(payload: unknown): CatalogModel[] {
  const list = isRecord(payload) ? payload.data : payload;
  if (!Array.isArray(list)) {
    throw new EmpirioLabsError("The EmpirioLabs AI model catalog was not in the expected format.", {
      code: "invalid_response",
    });
  }
  return list.filter((entry): entry is CatalogModel => isRecord(entry) && typeof entry.id === "string" && entry.id !== "");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The live public catalog, read without the API key and reused for 5 minutes.
 * Concurrent callers share one request; if a refresh fails, the previous copy
 * is used until the next attempt.
 */
export function loadCatalog(client: ApiClient, signal?: AbortSignal): Promise<CatalogModel[]> {
  const key = client.baseURL;
  const entry = cache.get(key);
  if (entry?.models && entry.expires > Date.now()) {
    return Promise.resolve(entry.models);
  }
  let pending = entry?.pending;
  if (!pending) {
    const stale = entry?.models;
    pending = client
      .getJson<unknown>("/models", { auth: false, timeoutMs: 30_000 })
      .then(parseCatalog)
      .then(
        (models) => {
          cache.set(key, { models, expires: Date.now() + CATALOG_CACHE_TTL_MS });
          return models;
        },
        (error: unknown) => {
          cache.set(key, { ...(stale ? { models: stale } : {}), expires: 0 });
          if (stale) {
            return stale;
          }
          throw error;
        },
      );
    cache.set(key, { ...(stale ? { models: stale } : {}), expires: entry?.expires ?? 0, pending });
  }
  return abortable(pending, signal);
}

/** Models that serve `endpoint`, optionally in one category and with one feature, and are available. */
export function candidates(models: readonly CatalogModel[], spec: TaskSpec): CatalogModel[] {
  return models.filter((model) => {
    if (!stringList(model.supported_endpoints).includes(spec.endpoint)) {
      return false;
    }
    if (spec.category && model.category !== spec.category) {
      return false;
    }
    if (spec.feature && !stringList(model.features).includes(spec.feature)) {
      return false;
    }
    return model.status === undefined || model.status === null || model.status === "available";
  });
}

/** The default model for a task: featured first, then Native Inference, then catalog order. */
export function pickDefault(models: readonly CatalogModel[], spec: TaskSpec): CatalogModel {
  const pool = candidates(models, spec);
  const ranked = pool
    .map((model, index) => ({ model, index }))
    .sort(
      (a, b) =>
        (a.model.is_featured ? 0 : 1) - (b.model.is_featured ? 0 : 1) ||
        (a.model.native_inference ? 0 : 1) - (b.model.native_inference ? 0 : 1) ||
        a.index - b.index,
    );
  const first = ranked[0];
  if (!first) {
    throw new EmpirioLabsError(
      "No model in the EmpirioLabs AI catalog supports this request right now. Pass a model ID from findModels.",
      { code: "no_default_model" },
    );
  }
  return first.model;
}

/** The catalog entry for a model ID or one of its aliases. */
export function findEntry(models: readonly CatalogModel[], id: string): CatalogModel | undefined {
  const wanted = id.trim().toLowerCase();
  return (
    models.find((model) => model.id.toLowerCase() === wanted) ??
    models.find((model) => stringList(model.aliases).some((alias) => alias.toLowerCase() === wanted))
  );
}

/** A short price summary from the catalog's `pricing_rows`, for example `Image generation: $0.0085 per image`. */
export function priceSummary(model: CatalogModel, limit = 3): string {
  const rows = Array.isArray(model.pricing_rows) ? model.pricing_rows : [];
  const parts: string[] = [];
  for (const row of rows.slice(0, limit)) {
    if (!isRecord(row)) {
      continue;
    }
    const label = text(row.label);
    const value = [text(row.value), text(row.spec)].filter(Boolean).join(" ");
    if (value) {
      parts.push(label ? `${label}: ${value}` : value);
    }
  }
  if (rows.length > limit) {
    parts.push(`+${rows.length - limit} more`);
  }
  return parts.length > 0 ? parts.join("; ") : `See ${text(model.api_url) || PRICING_URL}`;
}

/** True when every word appears in the model's ID, name, description, author, aliases, or features. */
export function matchesQuery(model: CatalogModel, words: readonly string[]): boolean {
  const haystack = [
    model.id,
    text(model.display_name),
    text(model.description),
    text(model.author),
    stringList(model.aliases).join(" "),
    stringList(model.features).join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

type ParameterSpec = { name: string; options?: unknown; max?: unknown };

export function parameterSpec(model: CatalogModel | undefined, name: string): ParameterSpec | undefined {
  const parameters = Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
  for (const parameter of parameters) {
    if (isRecord(parameter) && parameter.name === name) {
      return parameter as ParameterSpec;
    }
  }
  return undefined;
}

/** The model's own spelling of an enum option, matched without regard to case. */
export function matchOption(model: CatalogModel | undefined, name: string, value: string): string | undefined {
  const options = parameterSpec(model, name)?.options;
  if (!Array.isArray(options)) {
    return undefined;
  }
  const wanted = value.trim().toLowerCase();
  const match = options.find((option) => String(option).toLowerCase() === wanted);
  return match === undefined ? undefined : String(match);
}
