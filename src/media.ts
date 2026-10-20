/** Reads generated files, job IDs, and transcripts out of API responses and jobs. */
import { isRecord } from "./http.js";

/** A generated file: a signed link, or inline base64 data when the API returns the bytes. */
export type MediaItem = {
  url?: string;
  base64?: string;
  mediaType?: string;
};

const LIST_KEYS = ["data", "images", "videos", "audio", "outputs"] as const;
const URL_KEYS = ["url", "video_url", "audio_url", "image_url"] as const;
const BASE64_KEYS = ["b64_json", "audio_base64"] as const;
const NESTED_KEYS = ["result", "output"] as const;

export const JOB_RUNNING = new Set(["queued", "pending", "processing", "running", "in_progress", "starting", "submitted"]);
export const JOB_SUCCEEDED = new Set(["completed", "succeeded", "success", "done"]);
export const JOB_FAILED = new Set(["failed", "error", "cancelled", "canceled", "expired", "rejected"]);

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//iu.test(value);
}

function mediaTypeOf(entry: Record<string, unknown>): string | undefined {
  for (const key of ["content_type", "mime_type", "media_type"]) {
    const value = entry[key];
    if (typeof value === "string" && value.includes("/")) {
      return value.split(";")[0]!.trim().toLowerCase();
    }
  }
  return undefined;
}

function inline(raw: string, entry: Record<string, unknown>): MediaItem {
  let data = raw;
  let mediaType = mediaTypeOf(entry);
  const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/su.exec(raw);
  if (match) {
    mediaType = mediaType ?? match[1]!.trim().toLowerCase();
    data = match[2]!;
  }
  return { base64: data, ...(mediaType ? { mediaType } : {}) };
}

function itemsOf(value: unknown): MediaItem[] {
  const list = isRecord(value) ? [value] : Array.isArray(value) ? value : [];
  const out: MediaItem[] = [];
  for (const entry of list) {
    if (isHttpUrl(entry)) {
      out.push({ url: entry });
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const url = URL_KEYS.map((key) => entry[key]).find(isHttpUrl);
    const mediaType = mediaTypeOf(entry);
    if (url) {
      out.push({ url, ...(mediaType ? { mediaType } : {}) });
    } else if (typeof entry.b64_json === "string" && entry.b64_json) {
      out.push(inline(entry.b64_json, entry));
    }
  }
  return out;
}

/** Generated files in an API response or a job, as links or inline data. */
export function mediaItems(payload: unknown, depth = 0): MediaItem[] {
  if (!isRecord(payload) || depth > 4) {
    return [];
  }
  for (const key of LIST_KEYS) {
    const items = itemsOf(payload[key]);
    if (items.length > 0) {
      return items;
    }
  }
  for (const key of URL_KEYS) {
    const value = payload[key];
    if (isHttpUrl(value)) {
      return [{ url: value }];
    }
  }
  for (const key of BASE64_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value) {
      return [inline(value, payload)];
    }
  }
  for (const key of NESTED_KEYS) {
    const nested = payload[key];
    const items = Array.isArray(nested) ? itemsOf(nested) : mediaItems(nested, depth + 1);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

/** The job ID of an async job envelope, if the payload is one. */
export function jobIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const status = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  const value = payload.job_id || (JOB_RUNNING.has(status) ? payload.id : undefined);
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** The plain-text transcript in a transcription result, if there is one. */
export function transcriptText(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }
  if (!isRecord(result)) {
    return undefined;
  }
  const text = result.text ?? result.transcript;
  if (typeof text === "string") {
    return text;
  }
  const segments = result.segments;
  if (Array.isArray(segments)) {
    const parts = segments
      .map((segment) => (isRecord(segment) && typeof segment.text === "string" ? segment.text.trim() : ""))
      .filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  return undefined;
}
