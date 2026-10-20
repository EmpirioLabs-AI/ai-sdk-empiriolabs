/** The tools inside the real AI SDK tool loop, driven by a scripted language model. */
import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { empiriolabsTools } from "../src/index.js";
import { API, CDN, TEST_KEY, bytes, catalogRoute, createFetch, json } from "./helpers.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCall(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    usage,
    warnings: [],
  };
}

function reply(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage,
    warnings: [],
  };
}

const TOOL_NAMES = ["checkGenerationJob", "findModels", "generateImage", "generateVideo", "textToSpeech", "transcribeAudio"];

describe("with generateText", () => {
  it("finds a model, generates an image, and hands the link back to the model", async () => {
    const { fetchFn } = createFetch([
      catalogRoute(),
      ["POST", `${API}/images/generations`, json({ created: 1, data: [{ url: `${CDN}/bicycle.webp` }] })],
    ]);
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall("call-1", "findModels", { task: "image", limit: 5 }),
        toolCall("call-2", "generateImage", { prompt: "a red bicycle", model: "image-native" }),
        reply("Here is your image."),
      ],
    });
    const result = await generateText({
      model,
      tools: empiriolabsTools({ apiKey: TEST_KEY, fetch: fetchFn }),
      stopWhen: isStepCount(4),
      prompt: "Find a cheap image model and draw a red bicycle.",
    });
    expect(result.text).toBe("Here is your image.");
    const toolResults = result.steps.flatMap((step) => step.toolResults);
    expect(toolResults.map((part) => part.toolName)).toEqual(["findModels", "generateImage"]);
    expect(toolResults[1]!.output).toMatchObject({ status: "completed", urls: [`${CDN}/bicycle.webp`] });

    const offered = (model.doGenerateCalls[0]!.tools ?? []).flatMap((tool) => (tool.type === "function" ? [tool] : []));
    expect(offered.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    const image = offered.find((tool) => tool.name === "generateImage")!;
    expect(image.description).toContain("billed to the user's EmpirioLabs AI account");
    expect(image.inputSchema).toMatchObject({
      type: "object",
      required: ["prompt"],
      properties: { prompt: { type: "string" }, numberOfImages: { minimum: 1, maximum: 4 } },
    });
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain(`${CDN}/bicycle.webp`);
  });

  it("gives audio bytes to the application but only their size to the model", async () => {
    const audio = new Uint8Array(Array.from({ length: 64 }, (_, index) => index));
    const base64 = Buffer.from(audio).toString("base64");
    const { fetchFn } = createFetch([catalogRoute(), ["POST", `${API}/audio/speech`, () => bytes(audio, "audio/wav")]]);
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("call-1", "textToSpeech", { text: "Hello" }), reply("Done.")],
    });
    const result = await generateText({
      model,
      tools: empiriolabsTools({ apiKey: TEST_KEY, fetch: fetchFn }),
      stopWhen: isStepCount(3),
      prompt: "Say hello.",
    });
    const output = result.steps[0]!.toolResults[0]!.output as { inline: Array<{ base64: string }> };
    expect(output.inline[0]!.base64).toBe(base64);
    const seen = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(seen).not.toContain(base64);
    expect(seen).toContain('"bytes":64');
  });

  it("reports an API error to the model as text, without the key", async () => {
    const { fetchFn } = createFetch([
      ["POST", `${API}/videos/generations`, json({ error: { message: `No credits left for ${TEST_KEY}` } }, 402)],
    ]);
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("call-1", "generateVideo", { prompt: "waves", model: "video-turbo" }), reply("Sorry.")],
    });
    const result = await generateText({
      model,
      tools: empiriolabsTools({ apiKey: TEST_KEY, fetch: fetchFn }),
      stopWhen: isStepCount(3),
      prompt: "Make a video of waves.",
    });
    expect(result.text).toBe("Sorry.");
    const seen = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(seen).toContain("HTTP 402");
    expect(seen).toContain("Add credits at https://platform.empiriolabs.ai/dashboard/billing");
    expect(seen).not.toContain(TEST_KEY);
  });
});
