/**
 * Live smoke test against https://api.empiriolabs.ai, skipped unless
 * EMPIRIOLABS_API_KEY is set. It spends a few cents at most: one image from the
 * cheapest image model that takes the request, one short speech clip, the
 * transcription of that clip, and one agent run that generates one image.
 * Video is never generated here.
 *
 *   EMPIRIOLABS_API_KEY="sk-empiriolabs-..." npm run test:live
 *
 * EMPIRIOLABS_LIVE_CHAT_MODEL picks the agent's chat model (default qwen3-8-flash).
 * In the agent run, the tools get a fetch wrapper that refuses image requests
 * above a small price, so an agent that picks an expensive model cannot
 * overspend. The last step reads this run's cost from the usage log: the rows
 * for the models it used since it started (another client using the same key
 * at the same time would add rows of its own).
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isStepCount } from "ai";
import { describe, expect, it } from "vitest";
import {
  EmpirioLabsError,
  type FoundModel,
  empiriolabsTools,
  findModels,
  generateImage,
  textToSpeech,
  transcribeAudio,
} from "../src/index.js";
import { run } from "./helpers.js";

const KEY = process.env.EMPIRIOLABS_API_KEY?.trim() ?? "";
const describeLive = KEY ? describe : describe.skip;
const API = "https://api.empiriolabs.ai/v1";
const CHAT_MODEL = process.env.EMPIRIOLABS_LIVE_CHAT_MODEL?.trim() || "qwen3-8-flash";
/** The agent may use an image model only if every listed per-image price is at most this. */
const MAX_IMAGE_PRICE = 0.02;
const BUDGET_USD = 0.1;

// Vitest captures console output; stderr writes stay visible.
function log(message: string): void {
  process.stderr.write(`[live] ${message}\n`);
}

function dollars(text: string): number[] {
  return [...text.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/gu)].map((match) => Number(match[1]));
}

const started = Date.now();
const usedModels = new Set<string>();
let imageModels: FoundModel[] = [];
let speechUrl = "";

/** Lets the agent's image calls through only for cheap models and one image. */
function budgetGuard(allowed: ReadonlySet<string>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method === "POST") {
      if (!url.endsWith("/images/generations")) {
        throw new Error(`Live test budget guard: only image generation is allowed in the agent run (${url}).`);
      }
      const body = JSON.parse(String(init.body)) as { model?: string; num_images?: number };
      if (!body.model || !allowed.has(body.model) || (body.num_images ?? 1) > 1) {
        throw new Error(
          `Live test budget guard: ${body.model} x${body.num_images ?? 1} is not allowed. Use one of: ${[...allowed].join(", ")}.`,
        );
      }
      usedModels.add(body.model);
    }
    return fetch(input, init);
  };
}

async function checkLink(url: string, type: RegExp): Promise<number> {
  const response = await fetch(url);
  const size = (await response.arrayBuffer()).byteLength;
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type") ?? "").toMatch(type);
  return size;
}

describeLive("EmpirioLabs AI live smoke", () => {
  it("finds image and speech models with prices, without the API key", async () => {
    const tool = findModels();
    const images = await run(tool, { task: "image", limit: 100 });
    const speech = await run(tool, { task: "speech", limit: 100 });
    imageModels = images.models;
    log(`${images.total} image models (default ${images.models.find((model) => model.isDefault)?.id})`);
    log(`${speech.total} speech models (default ${speech.models.find((model) => model.isDefault)?.id})`);
    for (const model of images.models.slice(0, 3)) {
      log(`  ${model.id}: ${model.price}`);
    }
    expect(images.total).toBeGreaterThan(3);
    expect(speech.total).toBeGreaterThan(1);
    expect(images.models.every((model) => model.endpoints.includes("POST /v1/images/generations"))).toBe(true);
    expect(images.models.filter((model) => model.isDefault)).toHaveLength(1);
  }, 60_000);

  it("generates one image with the cheapest image model that takes the request", async () => {
    const ranked = imageModels
      .map((model) => ({ id: model.id, floor: Math.min(...dollars(model.price)) }))
      .filter((model) => Number.isFinite(model.floor))
      .sort((a, b) => a.floor - b.floor);
    log(`cheapest: ${ranked.slice(0, 4).map((model) => `${model.id} $${model.floor}`).join(", ")}`);
    const tool = generateImage();
    for (const candidate of ranked.slice(0, 3)) {
      try {
        const result = await run(tool, {
          prompt: "A small red paper boat on calm blue water, flat illustration.",
          model: candidate.id,
        });
        usedModels.add(candidate.id);
        expect(result.status).toBe("completed");
        if (result.status === "completed") {
          const size = await checkLink(result.urls[0]!, /^image\//u);
          log(`image from ${candidate.id} (listed $${candidate.floor}): ${size} bytes`);
        }
        return;
      } catch (error) {
        if (error instanceof EmpirioLabsError && error.status !== undefined && [400, 404, 422].includes(error.status)) {
          log(`${candidate.id} refused: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
    throw new Error("None of the three cheapest image models accepted the request.");
  }, 600_000);

  it("turns a short sentence into speech", async () => {
    const result = await run(textToSpeech(), {
      text: "EmpirioLabs AI tools for the AI SDK are working.",
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      usedModels.add(result.model);
      log(`speech from ${result.model}: ${result.urls.length} link(s), ${result.inline?.length ?? 0} inline`);
      expect(result.urls.length).toBeGreaterThan(0);
      speechUrl = result.urls[0]!;
      const size = await checkLink(speechUrl, /^(audio\/|application\/octet-stream)/u);
      log(`speech file: ${size} bytes`);
    }
  }, 600_000);

  it("transcribes the speech it produced", async () => {
    expect(speechUrl).toMatch(/^https:\/\//u);
    const result = await run(transcribeAudio(), { audioUrl: speechUrl });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      usedModels.add(result.model);
      log(`transcript from ${result.model}: ${JSON.stringify(result.text)}`);
      expect(result.text?.toLowerCase() ?? "").toMatch(/tools|working/u);
    }
  }, 600_000);

  it("runs an AI SDK agent that finds a cheap image model and generates an image", async () => {
    const allowed = new Set(
      imageModels.filter((model) => Math.max(...dollars(model.price)) <= MAX_IMAGE_PRICE).map((model) => model.id),
    );
    log(`agent may use: ${[...allowed].join(", ")}`);
    usedModels.add(CHAT_MODEL);

    // The README example, with the budget-guard fetch wrapper added to the tools.
    const empiriolabs = createOpenAICompatible({
      name: "empiriolabs",
      baseURL: "https://api.empiriolabs.ai/v1",
      apiKey: process.env.EMPIRIOLABS_API_KEY,
    });

    const { text, steps, totalUsage } = await generateText({
      model: empiriolabs(CHAT_MODEL),
      tools: empiriolabsTools({ fetch: budgetGuard(allowed) }),
      stopWhen: isStepCount(4),
      prompt:
        "Find a cheap image model, then use it to generate one image of a lighthouse at dawn in watercolor. " +
        "Reply with the image link.",
    });

    const urls: string[] = [];
    for (const step of steps) {
      for (const result of step.staticToolResults) {
        if (result.toolName === "generateImage" && result.output.status === "completed") {
          urls.push(...result.output.urls);
        }
      }
    }

    const calls = steps.flatMap((step) => step.toolCalls);
    log(`${CHAT_MODEL} made ${steps.length} steps; tool calls: ${calls.map((call) => `${call.toolName} ${JSON.stringify(call.input)}`).join(" | ")}`);
    for (const error of steps.flatMap((step) => step.content.filter((part) => part.type === "tool-error"))) {
      log(`tool error: ${error.toolName}: ${String((error as { error?: unknown }).error)}`);
    }
    log(`tokens: ${totalUsage.inputTokens} in, ${totalUsage.outputTokens} out`);
    log(`reply: ${JSON.stringify(text.slice(0, 300))}`);
    expect(calls.some((call) => call.toolName === "findModels")).toBe(true);
    expect(calls.some((call) => call.toolName === "generateImage")).toBe(true);
    expect(urls[0]).toMatch(/^https:\/\//u);
    log(`agent image: ${await checkLink(urls[0]!, /^image\//u)} bytes`);
  }, 900_000);

  it("stays within budget, by the usage log", async () => {
    // Usage rows land shortly after each request.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const response = await fetch(`${API}/account/usage?limit=100`, {
      headers: { Authorization: `Bearer ${KEY}` },
      redirect: "error",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ created_at: string; model: string; endpoint: string; status: string; cost?: { amount?: number } }>;
    };
    const rows = body.data.filter(
      (row) => Date.parse(row.created_at) >= started - 2_000 && usedModels.has(row.model),
    );
    log(`${rows.length} usage rows for this run's models since it started:`);
    let total = 0;
    for (const row of rows) {
      total += row.cost?.amount ?? 0;
      log(`  ${row.created_at} ${row.model} ${row.endpoint} ${row.status} $${(row.cost?.amount ?? 0).toFixed(6)}`);
    }
    log(`total: $${total.toFixed(6)}`);
    expect(total).toBeLessThan(BUDGET_USD);
  }, 60_000);
});
