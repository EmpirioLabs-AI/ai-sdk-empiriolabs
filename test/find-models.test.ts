import { describe, expect, it, vi } from "vitest";
import { findModels } from "../src/index.js";
import { API, TEST_KEY, catalogRoute, createFetch, run } from "./helpers.js";

type Schema = { safeParse(value: unknown): { success: boolean } };

describe("findModels", () => {
  it("lists image models with prices and endpoints, and marks the default", async () => {
    const { fetchFn } = createFetch([catalogRoute()]);
    const result = await run(findModels({ fetch: fetchFn }), { task: "image" });
    expect(result.total).toBe(4);
    expect(result.models.map((model) => model.id)).toEqual(["image-plain", "image-featured", "image-native", "image-editor"]);
    expect(result.models.find((model) => model.isDefault)?.id).toBe("image-native");
    expect(result.models[2]).toEqual({
      id: "image-native",
      name: "Image Native",
      price: "Image generation: $0.0085 (was $0.014) per image",
      endpoints: ["POST /v1/images/generations"],
      isDefault: true,
    });
  });

  it("maps every task onto the catalog", async () => {
    const { fetchFn } = createFetch([catalogRoute()]);
    const tool = findModels({ fetch: fetchFn });
    const idsFor = async (task: "chat" | "image-edit" | "video" | "speech" | "transcription" | "embedding") =>
      (await run(tool, { task })).models.map((model) => model.id);
    expect(await idsFor("chat")).toEqual(["chat-pro"]);
    expect(await idsFor("image-edit")).toEqual(["image-editor"]);
    expect(await idsFor("video")).toEqual(["video-turbo"]);
    expect(await idsFor("speech")).toEqual(["voice-one", "voice-raw"]);
    expect(await idsFor("transcription")).toEqual(["stt-turbo"]);
    expect(await idsFor("embedding")).toEqual(["embed-v4"]);
  });

  it("matches every query word against the ID, name, description, author, aliases, and features", async () => {
    const { fetchFn } = createFetch([catalogRoute()]);
    const tool = findModels({ fetch: fetchFn });
    expect((await run(tool, { task: "image", query: "FLUX" })).models.map((model) => model.id)).toEqual(["image-native"]);
    expect((await run(tool, { task: "image", query: "image editing" })).models.map((model) => model.id)).toEqual([
      "image-editor",
    ]);
    expect((await run(tool, { task: "speech", query: "latest" })).models.map((model) => model.id)).toEqual(["voice-raw"]);
    expect((await run(tool, { task: "image", query: "nothing-matches" })).total).toBe(0);
  });

  it("limits the list but reports the full count", async () => {
    const { fetchFn } = createFetch([catalogRoute()]);
    const result = await run(findModels({ fetch: fetchFn }), { task: "image", limit: 2 });
    expect(result.models).toHaveLength(2);
    expect(result.total).toBe(4);
  });

  it("works without an API key and never sends one", async () => {
    const { fetchFn, calls } = createFetch([catalogRoute()]);
    await run(findModels({ fetch: fetchFn }), { task: "video" });
    vi.stubEnv("EMPIRIOLABS_API_KEY", TEST_KEY);
    const keyed = createFetch([catalogRoute()]);
    await run(findModels({ apiKey: TEST_KEY, fetch: keyed.fetchFn }), { task: "video" });
    for (const call of [...calls, ...keyed.calls]) {
      expect(call.url).toBe(`${API}/models`);
      expect(call.headers.has("authorization")).toBe(false);
    }
  });

  it("says it is free and validates the task", () => {
    const tool = findModels();
    expect(tool.description).toContain("Free: nothing is billed.");
    const schema = tool.inputSchema as unknown as Schema;
    expect(schema.safeParse({ task: "image" }).success).toBe(true);
    expect(schema.safeParse({ task: "music" }).success).toBe(false);
    expect(schema.safeParse({ task: "image", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ task: "image", limit: 101 }).success).toBe(false);
  });
});
