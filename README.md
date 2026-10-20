# EmpirioLabs AI tools for the AI SDK

`@empiriolabs/ai-sdk` gives [Vercel AI SDK](https://ai-sdk.dev) agents tools for the [EmpirioLabs AI](https://empiriolabs.ai) media API: generate and edit images, generate videos, turn text into speech, transcribe audio, check generation jobs, and find models with their prices. When a tool call names no model, the tool uses a featured model from the live EmpirioLabs AI catalog, so new models work without a package update.

EmpirioLabs AI is a specialized AI inference and integration provider. It self-hosts open-source models on GPU infrastructure it manages, runs optimized endpoints for proprietary models, and offers on-demand GPU Cloud instances and hosted AI agents.

## Requirements

- AI SDK 7 (`ai`) and Zod 3.25 or 4. AI SDK 7 runs on Node.js 22 or later.
- An EmpirioLabs AI API key. Create one at [https://platform.empiriolabs.ai/dashboard/api-keys](https://platform.empiriolabs.ai/dashboard/api-keys). Keys start with `sk-empiriolabs-`.

## Install

```bash
npm install @empiriolabs/ai-sdk ai zod
```

Set the key in the environment your agent runs in. The tools read `EMPIRIOLABS_API_KEY` when they run:

```bash
export EMPIRIOLABS_API_KEY="sk-empiriolabs-..."
```

Run the tools on your server, not in browser code, so the key stays private.

## Example

This agent finds a cheap image model, generates one image with it, and replies with the link. It uses an EmpirioLabs AI chat model through the AI SDK OpenAI-compatible provider (`npm install @ai-sdk/openai-compatible`); the tools work with any AI SDK model that supports tool calling, such as a gateway model string like `'anthropic/claude-sonnet-5.5'`.

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, isStepCount } from 'ai';
import { empiriolabsTools } from '@empiriolabs/ai-sdk';

const empiriolabs = createOpenAICompatible({
  name: 'empiriolabs',
  baseURL: 'https://api.empiriolabs.ai/v1',
  apiKey: process.env.EMPIRIOLABS_API_KEY,
});

const { text, steps } = await generateText({
  model: empiriolabs('qwen3-8-flash'),
  tools: empiriolabsTools(),
  stopWhen: isStepCount(4),
  prompt:
    'Find a cheap image model, then use it to generate one image of a lighthouse at dawn in watercolor. ' +
    'Reply with the image link.',
});

console.log(text);

// The links are also in the tool results.
for (const step of steps) {
  for (const result of step.staticToolResults) {
    if (result.toolName === 'generateImage' && result.output.status === 'completed') {
      console.log(result.output.urls);
    }
  }
}
```

## Tools

| Tool | What it does | Input |
| --- | --- | --- |
| `generateImage` | Generates images from a prompt, or edits images given as reference URLs (`POST /v1/images/generations`). | `prompt`, `model?`, `aspectRatio?`, `size?`, `numberOfImages?` (1 to 4), `referenceImageUrls?` (https URLs) |
| `generateVideo` | Generates a video from a prompt, or animates a still image, and waits for the job (`POST /v1/videos/generations`). | `prompt?`, `model?`, `imageUrl?` (https URL), `durationSeconds?`, `resolution?`, `aspectRatio?`, `generateAudio?` |
| `checkGenerationJob` | Returns a job's status and, once it is done, its output links, transcript, or error message (`GET /v1/jobs/{job_id}`). | `jobId` |
| `textToSpeech` | Turns text into speech (`POST /v1/audio/speech`). | `text`, `model?`, `voice?`, `format?` |
| `transcribeAudio` | Transcribes an audio or video file at an https URL (`POST /v1/audio/transcriptions`). | `audioUrl`, `model?`, `language?` |
| `findModels` | Lists the models for a task with a short price summary and their endpoints, from the public catalog. Free, and it does not use the API key. | `task` (`chat`, `image`, `image-edit`, `video`, `speech`, `transcription`, or `embedding`), `query?`, `limit?` (1 to 100) |

`empiriolabsTools()` returns all six, keyed by these names. To give an agent only some of them, call the factories:

```ts
import { findModels, generateImage } from '@empiriolabs/ai-sdk';

const tools = {
  findModels: findModels(),
  generateImage: generateImage({ model: 'flux-2-klein-4b' }),
};
```

Model IDs are listed at [https://empiriolabs.ai/models](https://empiriolabs.ai/models), and `findModels` returns them with prices.

## Options

Every factory takes the same optional settings:

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | `process.env.EMPIRIOLABS_API_KEY` | Read when a tool runs. |
| `baseURL` | `https://api.empiriolabs.ai/v1` | An `https` URL that includes `/v1`. The API key is sent only to this host. |
| `model` | A featured model from the live catalog | Used when a tool call names no model. A model the tool call names is sent as given. |
| `waitTimeoutMs` | `300000` (5 minutes) | How long a generation tool waits for a queued job before returning its job ID. |
| `fetch` | The global `fetch` | For a proxy or for tests. |

`empiriolabsTools()` takes `apiKey`, `baseURL`, `waitTimeoutMs`, and `fetch`, plus a default model per tool:

```ts
empiriolabsTools({
  waitTimeoutMs: 120_000,
  models: { image: 'flux-2-klein-4b', speech: 'tts-2' },
});
```

## Jobs and expiring links

- Videos, and some images, speech, and transcriptions, run as jobs. A tool waits up to `waitTimeoutMs` for the job. If it is still running, the tool returns `{ status: "processing", jobId }`, and the agent can pass the `jobId` to `checkGenerationJob` later. Sending the same request again would start, and bill, a new job.
- Links to generated files are signed and expire. Download anything you want to keep.
- A few speech models return the audio data instead of a link. The tool result then carries it as base64 in `inline`, for your application; the model sees only the media type and size.

## Errors

A failed request throws an `EmpirioLabsError` with the API's own message, the HTTP `status`, and the API's error `code`. The AI SDK passes the message to the model as the tool's error, so the agent can tell the user what to do next, for example to add credits. Messages never contain the API key. GET requests are retried after rate limits and server errors; generation requests are retried only after a rate limit.

## Pricing

Each generation is billed to your EmpirioLabs AI account at the model's listed price. `findModels` shows a price summary for every model and is free. Full pricing: [https://empiriolabs.ai/pricing](https://empiriolabs.ai/pricing).

## Development

```bash
npm install
npm run typecheck
npm test               # unit tests with a mocked fetch
npm run build
npm pack --dry-run
```

The live smoke test runs against the API and spends a few cents: one image, one short speech clip, its transcription, and one agent run that generates one image. It is skipped when `EMPIRIOLABS_API_KEY` is not set.

```bash
EMPIRIOLABS_API_KEY="sk-empiriolabs-..." npm run test:live
```

Set `EMPIRIOLABS_LIVE_CHAT_MODEL` to choose the agent's chat model.

### Releasing

Pushing a version tag such as `0.1.0` runs the [Publish workflow](.github/workflows/publish.yml). It runs the typecheck and the unit tests, packs the package once, and publishes it to npm with a provenance statement. The tag must match the `version` in `package.json` and `PACKAGE_VERSION` in `src/constants.ts`.

## Resources

- [EmpirioLabs AI](https://empiriolabs.ai)
- [Documentation](https://docs.empiriolabs.ai)
- [API keys](https://platform.empiriolabs.ai/dashboard/api-keys)
- [Models](https://empiriolabs.ai/models) and [pricing](https://empiriolabs.ai/pricing)
- [AI SDK](https://ai-sdk.dev)
- Support: [support@empiriolabs.ai](mailto:support@empiriolabs.ai)

## License

[MIT](LICENSE)
