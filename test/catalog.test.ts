import { describe, expect, it, vi } from "vitest";
import {
  MODEL_TASKS,
  candidates,
  findEntry,
  loadCatalog,
  matchOption,
  pickDefault,
  priceSummary,
} from "../src/catalog.js";
import { ApiClient } from "../src/http.js";
import { API, CATALOG, TEST_KEY, catalogRoute, createFetch, json, rejection, sequence } from "./helpers.js";

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe("default model", () => {
  it("prefers featured, then Native Inference, then catalog order, and skips unavailable models", () => {
    expect(pickDefault(CATALOG, MODEL_TASKS.image).id).toBe("image-native");
    expect(pickDefault(CATALOG, MODEL_TASKS.transcription).id).toBe("stt-turbo");
    expect(pickDefault(CATALOG, MODEL_TASKS.speech).id).toBe("voice-one");
    expect(pickDefault(CATALOG, MODEL_TASKS.video).id).toBe("video-turbo");
  });

  it("falls back to catalog order when nothing is featured", () => {
    const rows = CATALOG.filter((row) => row.category === "image").map((row) => ({ ...row, is_featured: false }));
    expect(pickDefault(rows, MODEL_TASKS.image).id).toBe("image-native");
    const plain = rows.map((row) => ({ ...row, native_inference: false }));
    expect(pickDefault(plain, MODEL_TASKS.image).id).toBe("image-plain");
  });

  it("uses only image-editing models when editing", () => {
    expect(pickDefault(CATALOG, MODEL_TASKS["image-edit"]).id).toBe("image-editor");
  });

  it("says so when no model fits", () => {
    expect(() => pickDefault([], MODEL_TASKS.image)).toThrow(/Pass a model ID from findModels/u);
  });
});

describe("candidates", () => {
  it("filters on endpoint, category, feature, and status", () => {
    expect(ids(candidates(CATALOG, MODEL_TASKS.chat))).toEqual(["chat-pro"]);
    expect(ids(candidates(CATALOG, MODEL_TASKS.image))).toEqual([
      "image-plain",
      "image-featured",
      "image-native",
      "image-editor",
    ]);
    expect(ids(candidates(CATALOG, MODEL_TASKS["image-edit"]))).toEqual(["image-editor"]);
    expect(ids(candidates(CATALOG, MODEL_TASKS.speech))).toEqual(["voice-one", "voice-raw"]);
    expect(ids(candidates(CATALOG, MODEL_TASKS.embedding))).toEqual(["embed-v4"]);
  });
});

describe("price summary", () => {
  it("joins up to three pricing rows and counts the rest", () => {
    const editor = CATALOG.find((row) => row.id === "image-editor")!;
    expect(priceSummary(editor)).toBe("Low: $0.01 per image; Medium: $0.02 per image; High: $0.04 per image; +1 more");
    const native = CATALOG.find((row) => row.id === "image-native")!;
    expect(priceSummary(native)).toBe("Image generation: $0.0085 (was $0.014) per image");
  });

  it("points to the pricing page when a model lists no prices", () => {
    expect(priceSummary({ id: "x" })).toBe("See https://empiriolabs.ai/pricing");
    expect(priceSummary({ id: "x", api_url: "https://docs.example.com/x" })).toBe("See https://docs.example.com/x");
  });
});

describe("catalog entries", () => {
  it("finds a model by ID or alias, and matches enum options without regard to case", () => {
    expect(findEntry(CATALOG, "VOICE-ONE")?.id).toBe("voice-one");
    expect(findEntry(CATALOG, "voice-raw-latest")?.id).toBe("voice-raw");
    expect(findEntry(CATALOG, "missing")).toBeUndefined();
    const voice = findEntry(CATALOG, "voice-one");
    expect(matchOption(voice, "output_format", "mp3")).toBe("MP3");
    expect(matchOption(voice, "output_format", "flac")).toBeUndefined();
    expect(matchOption(voice, "voice", "x")).toBeUndefined();
  });
});

describe("catalog cache", () => {
  it("reads the public catalog without the API key", async () => {
    const { fetchFn, calls } = createFetch([catalogRoute()]);
    const models = await loadCatalog(new ApiClient({ apiKey: TEST_KEY, fetch: fetchFn }));
    expect(models).toHaveLength(CATALOG.length);
    expect(calls[0]!.headers.has("authorization")).toBe(false);
  });

  it("reuses the catalog for five minutes", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([catalogRoute()]);
    const client = new ApiClient({ fetch: fetchFn });
    await loadCatalog(client);
    vi.advanceTimersByTime(4 * 60_000);
    await loadCatalog(client);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    await loadCatalog(client);
    expect(calls).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { fetchFn, calls } = createFetch([catalogRoute()]);
    const client = new ApiClient({ fetch: fetchFn });
    const [a, b] = await Promise.all([loadCatalog(client), loadCatalog(client)]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("keeps using the previous copy when a refresh fails", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, sequence(() => json({ data: CATALOG }), () => json({ error: "gone" }, 404))],
    ]);
    const client = new ApiClient({ fetch: fetchFn });
    const first = await loadCatalog(client);
    vi.advanceTimersByTime(6 * 60_000);
    const second = await loadCatalog(client);
    expect(second).toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("rejects a catalog in an unexpected format", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, json({ data: "nope" })]]);
    const error = await rejection(loadCatalog(new ApiClient({ fetch: fetchFn })));
    expect(error.code).toBe("invalid_response");
  });
});
