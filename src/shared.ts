/** Option types, result shapes, and helpers shared by the tools. */
import type { JSONValue, Tool } from "ai";
import { type CatalogModel, type TaskSpec, findEntry, loadCatalog, pickDefault } from "./catalog.js";
import { DEFAULT_WAIT_TIMEOUT_MS, EXPIRING_LINKS_NOTE } from "./constants.js";
import { EmpirioLabsError } from "./errors.js";
import { ApiClient, type EmpirioLabsClientOptions, isRecord } from "./http.js";
import type { MediaItem } from "./media.js";

export type { EmpirioLabsClientOptions } from "./http.js";

/** Options for a generation tool. Every field is optional. */
export type EmpirioLabsToolOptions = EmpirioLabsClientOptions & {
  /**
   * Model ID to use when the tool call does not name one. When neither is set,
   * the tool uses a featured model from the live catalog.
   */
  model?: string;
  /**
   * How long to wait for a queued job before returning its job ID with status
   * `processing`, in milliseconds. Defaults to 300000 (5 minutes).
   */
  waitTimeoutMs?: number;
};

/** A tool with an `execute` function, as returned by the AI SDK `tool()` helper. */
export type EmpirioLabsTool<INPUT, OUTPUT> = Tool<INPUT, OUTPUT> & {
  execute: NonNullable<Tool<INPUT, OUTPUT>["execute"]>;
};

/** Generated data the API returned directly instead of as a link. */
export type InlineFile = {
  /** Base64-encoded bytes. Kept out of what the model sees; available to your application. */
  base64: string;
  mediaType?: string;
};

/** Returned when a job is still running after the wait limit. */
export type ProcessingResult = {
  status: "processing";
  model: string;
  jobId: string;
  message: string;
};

/** A finished generation with signed, expiring links (and inline data from the few models that send bytes). */
export type CompletedMediaResult = {
  status: "completed";
  model: string;
  jobId?: string;
  urls: string[];
  inline?: InlineFile[];
  note: string;
};

export function createClient(options: EmpirioLabsClientOptions): ApiClient {
  return new ApiClient(options);
}

export function waitTimeout(options: { waitTimeoutMs?: number }): number {
  const value = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EmpirioLabsError("waitTimeoutMs must be a number of milliseconds, 0 or more.", {
      code: "invalid_wait_timeout",
    });
  }
  return value;
}

export function describeWait(timeoutMs: number): string {
  if (timeoutMs >= 60_000) {
    const minutes = Math.round(timeoutMs / 60_000);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.round(timeoutMs / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** The sentence a tool description uses for its default model. */
export function defaultModelSentence(model: string | undefined, kind: string): string {
  return model
    ? `When model is omitted, ${model} is used.`
    : `When model is omitted, a featured ${kind} model from the live catalog is used.`;
}

/** The model a call uses: the one the call names, the configured one, or the catalog default. */
export async function resolveModel(
  client: ApiClient,
  requested: string | undefined,
  configured: string | undefined,
  spec: TaskSpec,
  signal: AbortSignal | undefined,
): Promise<{ id: string; entry?: CatalogModel }> {
  const named = requested?.trim() || configured?.trim();
  if (named) {
    return { id: named };
  }
  const entry = pickDefault(await loadCatalog(client, signal), spec);
  return { id: entry.id, entry };
}

/** The catalog entry for a model, or undefined when the catalog cannot be read. */
export async function catalogEntry(
  client: ApiClient,
  id: string,
  signal: AbortSignal | undefined,
): Promise<CatalogModel | undefined> {
  try {
    return findEntry(await loadCatalog(client, signal), id);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return undefined;
  }
}

export const INLINE_DATA_NOTE =
  "The file data was returned directly to the application, so there is no link to download.";

/** Splits generated files into links and inline data, with the note that fits them. */
export function splitMedia(items: readonly MediaItem[]): { urls: string[]; inline?: InlineFile[]; note: string } {
  const urls = items.flatMap((item) => (item.url ? [item.url] : []));
  const inline = items.flatMap((item) =>
    item.base64 ? [{ base64: item.base64, ...(item.mediaType ? { mediaType: item.mediaType } : {}) }] : [],
  );
  return {
    urls,
    ...(inline.length > 0 ? { inline } : {}),
    note: urls.length > 0 || inline.length === 0 ? EXPIRING_LINKS_NOTE : INLINE_DATA_NOTE,
  };
}

export function completedMedia(model: string, items: readonly MediaItem[], jobId?: string): CompletedMediaResult {
  return { status: "completed", model, ...(jobId ? { jobId } : {}), ...splitMedia(items) };
}

export function processing(model: string, jobId: string, what: string): ProcessingResult {
  return {
    status: "processing",
    model,
    jobId,
    message:
      `The ${what} is not ready yet. Call checkGenerationJob with this jobId later to get it. ` +
      "Sending the request again would start and bill a new job.",
  };
}

function decodedSize(base64: string): number {
  const clean = base64.replace(/\s/gu, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * What the language model sees: the result without inline base64 data, which
 * stays available to the application in the tool result.
 */
export function forModel(output: unknown): { type: "json"; value: JSONValue } {
  if (isRecord(output) && Array.isArray(output.inline)) {
    const inline = output.inline.map((file: unknown) =>
      isRecord(file) && typeof file.base64 === "string"
        ? {
            ...(typeof file.mediaType === "string" ? { mediaType: file.mediaType } : {}),
            bytes: decodedSize(file.base64),
            delivered: "to the application as base64 data",
          }
        : file,
    );
    return { type: "json", value: JSON.parse(JSON.stringify({ ...output, inline })) as JSONValue };
  }
  return { type: "json", value: JSON.parse(JSON.stringify(output ?? null)) as JSONValue };
}
