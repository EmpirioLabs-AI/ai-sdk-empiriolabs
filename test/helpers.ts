/** Test helpers: a scripted fetch, a catalog fixture, and a way to run tools. */
import { vi } from "vitest";
import type { CatalogModel } from "../src/catalog.js";
import type { EmpirioLabsTool } from "../src/shared.js";

export const API = "https://api.empiriolabs.ai/v1";
export const CDN = "https://media.example.com/outputs";
export const TEST_KEY = "sk-empiriolabs-unit-test-key-0123456789";

export type RecordedCall = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  redirect: RequestInit["redirect"];
  signal: AbortSignal | undefined;
  /** Date.now() when the request was sent (fake time in timer tests). */
  at: number;
};

type Responder = (call: RecordedCall) => Response | Promise<Response>;
export type Route = [method: string, match: string | RegExp, respond: Responder | Response];

/** A fetch double that answers from a route table and records every call. */
export function createFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = {
      url,
      method,
      headers: new Headers(init?.headers),
      body,
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
      at: Date.now(),
    };
    calls.push(call);
    const route = routes.find(
      ([routeMethod, match]) =>
        routeMethod.toUpperCase() === method && (typeof match === "string" ? url === match : match.test(url)),
    );
    if (!route) {
      throw new Error(`Unexpected request: ${method} ${url}`);
    }
    const respond = route[2];
    return respond instanceof Response ? respond.clone() : respond(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function bytes(data: Uint8Array | string, contentType: string): Response {
  const buffer = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Response(buffer, {
    status: 200,
    headers: { "Content-Type": contentType, "Content-Length": String(buffer.byteLength) },
  });
}

/** Responds with each item in turn, then repeats the last one. */
export function sequence(...responses: Array<(call: RecordedCall) => Response>): Responder {
  let index = 0;
  return (call) => {
    const factory = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return factory(call);
  };
}

const image = "POST /v1/images/generations";

export const CATALOG: CatalogModel[] = [
  {
    id: "chat-pro",
    display_name: "Chat Pro",
    category: "text",
    status: "available",
    is_featured: true,
    supported_endpoints: ["POST /v1/chat/completions", "POST /v1/responses"],
    features: ["function_calling"],
    pricing_rows: [
      { label: "Input", value: "$0.16", spec: "per 1M prompt tokens" },
      { label: "Output", value: "$0.47", spec: "per 1M generated tokens" },
    ],
  },
  {
    id: "search-answer",
    category: "research",
    status: "available",
    supported_endpoints: ["POST /v1/chat/completions"],
  },
  {
    id: "image-plain",
    display_name: "Image Plain",
    category: "image",
    status: "available",
    supported_endpoints: [image],
    pricing_rows: [{ label: "Standard", value: "$0.03", spec: "per image" }],
  },
  {
    id: "image-featured",
    display_name: "Image Featured",
    category: "image",
    status: "available",
    is_featured: true,
    supported_endpoints: [image],
    pricing_rows: [{ label: "Standard", value: "$0.05", spec: "per image" }],
  },
  {
    id: "image-native",
    display_name: "Image Native",
    category: "image",
    status: "available",
    is_featured: true,
    native_inference: true,
    supported_endpoints: [image],
    description: "Fast flux-style generation",
    pricing_rows: [{ label: "Image generation", value: "$0.0085 (was $0.014)", spec: "per image" }],
  },
  {
    id: "image-editor",
    display_name: "Image Editor",
    category: "image",
    status: "available",
    supported_endpoints: [image],
    features: ["image_generation", "image_editing"],
    pricing_rows: [
      { label: "Low", value: "$0.01", spec: "per image" },
      { label: "Medium", value: "$0.02", spec: "per image" },
      { label: "High", value: "$0.04", spec: "per image" },
      { label: "Ultra", value: "$0.08", spec: "per image" },
    ],
  },
  {
    id: "image-retired",
    category: "image",
    status: "unavailable",
    is_featured: true,
    native_inference: true,
    supported_endpoints: [image],
  },
  {
    id: "video-turbo",
    display_name: "Video Turbo",
    category: "video",
    status: "available",
    is_featured: true,
    supported_endpoints: ["POST /v1/videos/generations"],
    pricing_rows: [{ label: "720p", value: "$0.18", spec: "per second" }],
  },
  {
    id: "voice-one",
    display_name: "Voice One",
    category: "audio",
    status: "available",
    is_featured: true,
    supported_endpoints: ["POST /v1/audio/speech", "GET /v1/voices"],
    supported_parameters: [
      { name: "input", type: "string", required: true, max: 40 },
      { name: "output_format", type: "enum", options: ["MP3", "WAV"] },
    ],
    pricing_rows: [{ label: "Synthesis", value: "$22.00", spec: "per 1M characters" }],
  },
  {
    id: "voice-raw",
    category: "audio",
    status: "available",
    supported_endpoints: ["POST /v1/audio/speech"],
    aliases: ["voice-raw-latest"],
    supported_parameters: [{ name: "response_format", type: "enum", options: ["mp3", "wav", "pcm"] }],
  },
  {
    id: "music-gen",
    category: "audio",
    status: "available",
    is_featured: true,
    supported_endpoints: ["POST /v1/audio/generations"],
  },
  {
    id: "stt-turbo",
    display_name: "STT Turbo",
    category: "transcription",
    status: "available",
    is_featured: true,
    native_inference: true,
    supported_endpoints: ["POST /v1/audio/transcriptions"],
    pricing_rows: [{ label: "Transcription", value: "$0.005", spec: "per minute of audio" }],
  },
  {
    id: "embed-v4",
    category: "embedding",
    status: "available",
    supported_endpoints: ["POST /v1/embeddings"],
  },
];

export function catalogRoute(rows: CatalogModel[] = CATALOG): Route {
  return ["GET", `${API}/models`, () => json({ object: "list", data: rows })];
}

/** Runs a tool's execute function the way the AI SDK does. */
export function run<INPUT, OUTPUT>(
  tool: EmpirioLabsTool<INPUT, OUTPUT>,
  input: INPUT,
  abortSignal?: AbortSignal,
): Promise<OUTPUT> {
  const result = tool.execute(input, {
    toolCallId: "call_test",
    messages: [],
    context: {},
    ...(abortSignal ? { abortSignal } : {}),
  });
  return Promise.resolve(result as OUTPUT | PromiseLike<OUTPUT>);
}

/** Advances fake timers until `promise` settles, then returns its outcome. */
export async function settle<T>(promise: Promise<T>, stepMs = 250, maxSteps = 10_000): Promise<T> {
  let done = false;
  let value: T | undefined;
  let failure: unknown;
  let failed = false;
  promise.then(
    (result) => {
      done = true;
      value = result;
    },
    (error: unknown) => {
      done = true;
      failed = true;
      failure = error;
    },
  );
  for (let step = 0; step < maxSteps && !done; step += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) {
    throw new Error("The promise did not settle.");
  }
  if (failed) {
    throw failure;
  }
  return value as T;
}

/** The error a promise rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("Expected the promise to reject.");
}
